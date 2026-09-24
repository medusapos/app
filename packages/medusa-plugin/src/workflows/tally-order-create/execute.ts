import type { MedusaContainer } from '@medusajs/framework/types'
import { ContainerRegistrationKeys, MedusaError } from '@medusajs/framework/utils'
import type { CommandEnvelope, CommandResult, OrderCreatePayload } from '@tallyui/core'
import { TALLY_LEDGER_MODULE } from '../../modules/tally-ledger'
import type TallyLedgerModuleService from '../../modules/tally-ledger/service'
import { parseCommandResult } from '../../modules/tally-ledger/command-result'
import { commandFingerprint } from './fingerprint'
import type { StockTopUp } from './stock'
import { payloadShapeErrors } from './payload-shape'
import { runOrderCreate, type TallyPluginOptions } from './run'

export type ExecuteOutcome =
  | { kind: 'result'; result: CommandResult }
  | { kind: 'in_progress'; id: string }
  | { kind: 'transient'; id: string; message: string }

export async function executeOrderCreate(
  container: MedusaContainer,
  command: CommandEnvelope<OrderCreatePayload>,
  options?: TallyPluginOptions
): Promise<ExecuteOutcome> {
  const errors = payloadShapeErrors(command.payload)
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
    if (!claim.claimed) {
      if (claim.command.fingerprint !== fingerprint) {
        return { kind: 'result', result: { id, status: 'rejected', error: {
          code: 'idempotency_mismatch', message: `Command ${id} was already used for a different payload.`,
        } } }
      }
      if (claim.command.status === 'in_progress') return { kind: 'in_progress', id }
      const result = parseCommandResult(claim.command.result)
      return { kind: 'result', result: claim.command.status === 'applied' ? { ...result, status: 'duplicate' } : result }
    }
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
        const result = await runOrderCreate(container, command, options, {
          claimToken: claim.claimToken, carriedTopUps: (claim.command.stock_topups_applied ?? []) as unknown as StockTopUp[],
        })
        await ledger.complete(id, claim.claimToken, result)
        completed = true
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
