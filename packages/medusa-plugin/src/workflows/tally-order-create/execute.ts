import type { MedusaContainer } from '@medusajs/framework/types'
import { ContainerRegistrationKeys, MedusaError } from '@medusajs/framework/utils'
import type { CommandEnvelope, CommandResult, OrderCreatePayload } from '@tallyui/core' with { 'resolution-mode': 'import' }
import { TALLY_LEDGER_MODULE } from '../../modules/tally-ledger'
import type TallyLedgerModuleService from '../../modules/tally-ledger/service'
import type { TallyCommandRecord } from '../../modules/tally-ledger/service'
import { parseCommandResult } from '../../modules/tally-ledger/command-result'
import { commandFingerprint } from './fingerprint'
import type { StockTopUp } from './stock'
import { payloadShapeErrors } from './payload-shape'
import { runOrderCreate, type TallyPluginOptions } from './run'
import { isNeedsAdminError } from './needs-admin-error'
import { isStoreConfigurationError } from './store-configuration-error'
import { checkCollision } from './collision'

export type ExecuteOutcome =
  | { kind: 'result'; result: CommandResult }
  | { kind: 'in_progress'; id: string }
  | { kind: 'transient'; id: string; message: string }

export async function replayOrderCreate(container: MedusaContainer, command: CommandEnvelope<OrderCreatePayload>): Promise<ExecuteOutcome | null> {
  const ledger = container.resolve<TallyLedgerModuleService>(TALLY_LEDGER_MODULE)
  try {
    const [row] = await ledger.listTallyCommands({ id: command.id })
    return row ? await replayResult(ledger, row, command.id, commandFingerprint(command)) : null
  } catch (error) {
    return { kind: 'transient', id: command.id, message: error.message }
  }
}

async function replayResult(ledger: TallyLedgerModuleService, row: TallyCommandRecord, id: string, fingerprint: string): Promise<ExecuteOutcome | null> {
  if (row.fingerprint !== fingerprint) {
    return { kind: 'result', result: { id, status: 'rejected', error: {
      code: 'idempotency_mismatch', message: `Command ${id} was already used for a different payload.`,
    } } }
  }
  if (row.status === 'in_progress') return null
  if (row.status === 'needs_admin') return { kind: 'in_progress', id }
  if (row.status === 'superseded') {
    const successor = row.superseded_by ? await ledger.retrieveCommandState(row.superseded_by) : null
    return successor?.status === 'applied'
      ? { kind: 'result', result: { ...parseCommandResult(successor.result), id, status: 'duplicate' } }
      : { kind: 'in_progress', id }
  }
  const result = parseCommandResult(row.result)
  return { kind: 'result', result: row.status === 'applied' ? { ...result, status: 'duplicate' } : result }
}

export async function executeOrderCreate(
  container: MedusaContainer,
  command: CommandEnvelope<OrderCreatePayload>,
  options?: TallyPluginOptions
): Promise<ExecuteOutcome> {
  const errors = payloadShapeErrors(command.payload, command.version as number)
  if (errors.length > 0) {
    return { kind: 'result', result: { id: command.id, status: 'rejected', error: {
      code: 'invalid_payload', message: errors.join('; '),
    } } }
  }
  const ledger = container.resolve<TallyLedgerModuleService>(TALLY_LEDGER_MODULE)
  const { id } = command
  try {
    const fingerprint = commandFingerprint(command)
    let claim: Awaited<ReturnType<TallyLedgerModuleService['claim']>>
    try {
      claim = await ledger.claim({ id, type: command.type, fingerprint })
    } catch (error) {
      if (MedusaError.isMedusaError(error) && error.type === MedusaError.Types.CONFLICT) {
        return { kind: 'in_progress', id }
      }
      throw error
    }
    if (!claim.claimed) return await replayResult(ledger, claim.command, id, fingerprint) ?? { kind: 'in_progress', id }
    let completed = false
    try {
      const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
      const connection = await knex.client.acquireConnection()
      try {
        const { rows: [{ locked }] } = await connection.query(
          "select pg_try_advisory_lock(hashtext('tally_order'), hashtext($1)) as locked", [command.payload.clientOrderId]
        )
        if (!locked) return { kind: 'in_progress', id }
        try {
          await ledger.assertClaim(id, claim.claimToken)
        } catch (error) {
          if (MedusaError.isMedusaError(error) && error.type === MedusaError.Types.CONFLICT) {
            return { kind: 'in_progress', id }
          }
          throw error
        }
        const collision = await checkCollision(container, command)
        if (collision.kind === 'copy') {
          await ledger.complete(id, claim.claimToken, collision.result)
          completed = true
          return { kind: 'result', result: collision.result }
        }
        if (collision.kind === 'transient') throw new Error(collision.message)
        if (collision.kind === 'busy') return { kind: 'in_progress', id }
        let result: CommandResult
        try {
          result = await runOrderCreate(container, command, options, {
            claimToken: claim.claimToken, carriedTopUps: (claim.command.stock_topups_applied ?? []) as unknown as StockTopUp[],
          })
        } catch (error) {
          if (isNeedsAdminError(error)) {
            const parked = await ledger.markNeedsAdmin(id, claim.claimToken, {
              orderId: error.orderId, clientOrderId: command.payload.clientOrderId, detail: error.detail,
            })
            // Parked, or the claim was lost: either way the row is not ours to release or delete.
            completed = true
            const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
            if (parked) logger.error(`tally order.create needs admin: command ${id}, order ${error.orderId}: ${error.detail}`)
            else logger.warn(`tally order.create: claim lost while parking command ${id} for an admin (order ${error.orderId}: ${error.detail})`)
            return { kind: 'in_progress', id }
          }
          if (!isStoreConfigurationError(error)) throw error
          return { kind: 'result', result: { id, status: 'rejected', error: {
            code: error.code, message: error.message,
          } } }
        }
        await ledger.complete(id, claim.claimToken, result)
        completed = true
        if (collision.kind === 'takeover') {
          try {
            if (!await ledger.markSuperseded(collision.commandId, collision.claimToken, id)) {
              container.resolve(ContainerRegistrationKeys.LOGGER).warn(`tally order.create: could not supersede command ${collision.commandId} by ${id}`)
            }
          } catch (error) {
            container.resolve(ContainerRegistrationKeys.LOGGER).warn(`tally order.create: could not supersede command ${collision.commandId} by ${id}: ${error.message}`)
          }
        }
        return { kind: 'result', result }
      } finally {
        try {
          await connection.query(
            "select pg_advisory_unlock(hashtext('tally_order'), hashtext($1))", [command.payload.clientOrderId]
          )
        } finally {
          await knex.client.releaseConnection(connection)
        }
      }
    } finally {
      if (!completed) {
        try {
          await ledger.release(id, claim.claimToken)
        } catch (error) {
          container.resolve(ContainerRegistrationKeys.LOGGER).error(`Could not release command ${id}.`, error)
        }
      }
    }
  } catch (error) {
    return { kind: 'transient', id, message: error.message }
  }
}
