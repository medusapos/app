import type { MedusaContainer } from '@medusajs/framework/types'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import type { CommandEnvelope, CommandResult, OrderCreatePayload } from '@tallyui/core' with { 'resolution-mode': 'import' }
import { TALLY_LEDGER_MODULE } from '../../modules/tally-ledger'
import type TallyLedgerModuleService from '../../modules/tally-ledger/service'
import { parseCommandResult } from '../../modules/tally-ledger/command-result'

export type Collision =
  | { kind: 'none' }
  | { kind: 'copy'; result: CommandResult }
  | { kind: 'transient'; message: string }
  | { kind: 'busy' }
  | { kind: 'takeover'; commandId: string; claimToken: string }

export async function checkCollision(
  container: MedusaContainer, command: CommandEnvelope<OrderCreatePayload>
): Promise<Collision> {
  const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  const order = await knex('order').select('id', knex.raw("metadata->>'tally_command_id' as command_id"))
    .whereRaw("metadata->>'tally_client_id' = ?", [command.payload.clientOrderId])
    .whereNull('deleted_at').whereNot('status', 'canceled').first()
  if (!order?.command_id || order.command_id === command.id) return { kind: 'none' }
  const ledger = container.resolve<TallyLedgerModuleService>(TALLY_LEDGER_MODULE)
  const state = await ledger.retrieveCommandState(order.command_id)
  if (!state) return { kind: 'none' }
  if (state.status === 'applied') {
    return { kind: 'copy', result: { ...parseCommandResult(state.result), id: command.id, status: 'applied' } }
  }
  if (state.status === 'superseded') {
    const row = await ledger.retrieveTallyCommand(order.command_id)
    const successor = row.superseded_by ? await ledger.retrieveCommandState(row.superseded_by) : null
    if (successor?.status === 'applied') {
      return { kind: 'copy', result: { ...parseCommandResult(successor.result), id: command.id, status: 'applied' } }
    }
  }
  if (state.status === 'in_progress' && state.stale) {
    const claimToken = await ledger.takeOverStaleClaim(order.command_id)
    return claimToken ? { kind: 'takeover', commandId: order.command_id, claimToken } : { kind: 'busy' }
  }
  if (state.status === 'rejected') {
    container.resolve(ContainerRegistrationKeys.LOGGER).error(`tally order.create: rejected command ${order.command_id} still has live order ${order.id}`)
  }
  return { kind: 'transient', message: `Command ${order.command_id} for order ${order.id} is ${state.status}` }
}
