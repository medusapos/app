import { randomUUID } from 'node:crypto'
import type { ExecArgs } from '@medusajs/framework/types'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { parseCommandResult } from '../modules/tally-ledger/command-result'

// npx medusa exec <built path>/tally-ledger-resolve.js <commandId> apply|reject [message]
// Resolves an order.create the ledger parked as needs_admin (see the plugin README).
export default async function tallyLedgerResolve({ container, args }: ExecArgs) {
  const [id, action, ...words] = args
  const message = words.join(' ') || (action === 'reject' ? 'Rejected by an admin.' : 'Fixed by an admin.')
  if (!id || (action !== 'apply' && action !== 'reject')) {
    throw new Error('Usage: medusa exec tally-ledger-resolve.js <commandId> apply|reject [message]')
  }
  const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  const row = await knex('tally_command').where({ id }).first()
  if (row?.status !== 'needs_admin') throw new Error(`Command ${id} is ${row?.status ?? 'missing'}, not needs_admin`)
  // apply: the resend reclaims at once (updated_at is past the lease) and resumes the fixed order.
  const update = action === 'apply'
    ? { status: 'in_progress', claim_token: randomUUID(), updated_at: knex.raw('to_timestamp(0)'), needs_admin_reason: null }
    : { status: 'rejected', updated_at: knex.fn.now(), result: JSON.stringify(parseCommandResult({
      id, status: 'rejected', error: { code: 'platform_error', message, data: {
        platformCode: 'needs_admin_rejected', platformMessage: message, orderId: row.needs_admin_reason?.orderId,
      } },
    })) }
  const updated = await knex('tally_command').where({ id, status: 'needs_admin' }).update(update)
  if (updated !== 1) throw new Error(`Command ${id} changed while resolving; nothing written`)
  container.resolve(ContainerRegistrationKeys.LOGGER).info(`tally-ledger-resolve: command ${id} ${action}: ${message}`)
}
