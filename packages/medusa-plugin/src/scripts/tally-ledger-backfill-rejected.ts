import type { ExecArgs } from '@medusajs/framework/types'
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'

// npx medusa exec <built path>/tally-ledger-backfill-rejected.js
// One-off and idempotent: marks tally_rejected on the order each tally-ledger-resolve reject parked, for rejects made
// before that script marked the order itself. No other order is touched (see the plugin README).
export default async function tallyLedgerBackfillRejected({ container }: ExecArgs) {
  const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const service = container.resolve(Modules.ORDER)
  const rows: { id: string; order_id: string }[] = await knex('tally_command')
    .select('id', knex.raw("result->'error'->'data'->>'orderId' as order_id")).where({ status: 'rejected' })
    .whereRaw("result->'error'->>'code' = 'platform_error'")
    .whereRaw("result->'error'->'data'->>'platformCode' = 'TALLY_ADMIN_REJECTED'")
    .whereRaw("result->'error'->'data'->>'orderId' is not null")
  let marked = 0, already = 0, live = 0, missing = 0
  for (const { id, order_id: orderId } of rows) {
    // Read per row, so a second command naming the same order sees it marked.
    const order = await knex('order').where({ id: orderId }).whereNull('deleted_at')
      .first('status', knex.raw("metadata->>'tally_rejected' as rejected"))
    if (!order) { missing++; continue }
    if (order.status !== 'canceled') {
      live++
      logger.warn(`tally_ledger_backfill_rejected: command ${id} is rejected but its order ${orderId} is ${order.status}; left unmarked`)
      continue
    }
    // The same test register figures use to skip a marked order.
    if (order.rejected === 'true') { already++; continue }
    const { metadata } = await service.retrieveOrder(orderId)
    await service.updateOrders(orderId, { metadata: { ...metadata, tally_rejected: true } })
    marked++
  }
  logger.info(`tally_ledger_backfill_rejected: marked ${marked} order(s), skipped ${already + live + missing} ` +
    `(already marked ${already}, not canceled ${live}, missing ${missing})`)
}
