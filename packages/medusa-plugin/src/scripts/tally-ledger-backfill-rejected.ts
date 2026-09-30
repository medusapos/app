import type { ExecArgs } from '@medusajs/framework/types'
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import { loadSessionFigures } from '../workflows/tally-register-command/figures'

// npx medusa exec <built path>/tally-ledger-backfill-rejected.js [--apply | --undo]
// One-off and idempotent: marks tally_rejected on the order each tally-ledger-resolve reject parked, for rejects made
// before that script marked the order itself. No other order is touched (see the plugin README).
// A manual script: no migration, job, subscriber or loader runs it. Without an argument it is a dry run that writes nothing;
// --apply also writes tally_rejected_by: 'backfill', the undo record, and --undo removes both keys. Each run logs the sessions' figures.
type Order = { id: string; session: string | null; client: string | null; payments: unknown; command?: string; sessions: string[] }
type Figures = Awaited<ReturnType<typeof loadSessionFigures>>
const PREFIX = 'tally_ledger_backfill_rejected'

export default async function tallyLedgerBackfillRejected({ container, args }: ExecArgs) {
  const mode = args.length === 0 ? 'dry run' : args.length === 1 && ['--apply', '--undo'].includes(args[0]) ? args[0] : null
  if (!mode) throw new Error('Usage: medusa exec tally-ledger-backfill-rejected.js [--apply | --undo] (no argument: a dry run)')
  const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const service = container.resolve(Modules.ORDER)
  const columns = ['id', knex.raw("metadata->>'tally_session_id' as session"), knex.raw("metadata->'tally_payments' as payments"),
    knex.raw("metadata->>'tally_client_id' as client")]
  // The sessions whose figures count an order, as loadSessionFigures decides: a closed session exactly the orders its closure lists
  // (whatever their tally_session_id), an open one the orders sent with its id.
  const closures: { session_id: string; order_ids: unknown[] }[] = await knex('tally_register_closure').select('session_id', 'order_ids')
  const sessionsOf = (order: { session: string | null; client: string | null }) => [
    ...order.session === null || closures.some(closure => closure.session_id === order.session) ? [] : [order.session],
    ...closures.filter(closure => order.client !== null && closure.order_ids.includes(order.client)).map(closure => closure.session_id)]
  if (mode === '--undo') {
    // Only orders --apply marked: an order tally-ledger-resolve marked itself has no tally_rejected_by.
    const orders: Order[] = await knex('order').select(columns).whereNull('deleted_at')
      .whereRaw("metadata->>'tally_rejected_by' = 'backfill'").orderBy('id')
    for (const order of orders) order.sessions = sessionsOf(order)
    const before = await figuresOf(container, orders)
    for (const { id } of orders) await service.updateOrders(id, { metadata: { tally_rejected: '', tally_rejected_by: '' } })
    report(logger, orders, before, await figuresOf(container, orders))
    logger.info(`${PREFIX} (undo): unmarked ${orders.length} order(s)`)
    return
  }
  const rows: { id: string; order_id: string | null }[] = await knex('tally_command')
    .select('id', knex.raw("result->'error'->'data'->>'orderId' as order_id")).where({ status: 'rejected' })
    .whereRaw("result->'error'->>'code' = 'platform_error'")
    .whereRaw("result->'error'->'data'->>'platformCode' = 'TALLY_ADMIN_REJECTED'")
    .whereNull('deleted_at')
  const marks = new Map<string, Order>()
  let already = 0, live = 0, missing = 0, unnamed = 0
  for (const { id, order_id: orderId } of rows) {
    // Never guess the order of a rejection that does not name one.
    if (orderId === null) { unnamed++; logger.warn(`${PREFIX}: skipped: no orderId (command ${id})`); continue }
    const order = await knex('order').where({ id: orderId }).whereNull('deleted_at')
      .first('status', knex.raw("metadata->>'tally_rejected' as rejected"), ...columns)
    if (!order) { missing++; continue }
    if (order.status !== 'canceled') {
      live++
      logger.warn(`tally_ledger_backfill_rejected: command ${id} is rejected but its order ${orderId} is ${order.status}; left unmarked`)
      continue
    }
    // The same test register figures use to skip a marked order.
    if (order.rejected === 'true' || marks.has(orderId)) { already++; continue }
    marks.set(orderId, { id: orderId, session: order.session, client: order.client, payments: order.payments, command: id, sessions: sessionsOf(order) })
  }
  const orders = [...marks.values()]
  const before = await figuresOf(container, orders)
  let after: Map<string, Figures>
  if (mode === '--apply') {
    // Only the marker keys, which the order module merges: this script does not hold the sale lock.
    for (const { id } of orders) await service.updateOrders(id, { metadata: { tally_rejected: true, tally_rejected_by: 'backfill' } })
    after = await figuresOf(container, orders)
  } else {
    // As if the marks were written: each marked order's payments and sale leave the figures of each session that counts it.
    after = new Map([...before].map(([session, figures]) => [session, figures && { ...figures, expected: { ...figures.expected } }]))
    for (const order of orders) for (const figures of order.sessions.map(id => after.get(id))) {
      if (!figures) continue
      figures.salesCount--
      for (const [method, amount] of Object.entries(amounts(order.payments))) figures.expected[method] = (figures.expected[method] ?? 0) - amount
    }
  }
  report(logger, orders, before, after)
  logger.info(`${mode === '--apply' ? `${PREFIX}: marked` : `${PREFIX} (dry run): would mark`} ${orders.length} order(s), ` +
    `skipped ${already + live + missing + unnamed} (already marked ${already}, not canceled ${live}, missing ${missing}, no orderId ${unnamed})`)
}

// Per method, with the guard register figures use for a malformed tally_payments row.
function amounts(payments: unknown) {
  const sums: Record<string, number> = {}
  for (const payment of Array.isArray(payments) ? payments : []) {
    if (typeof payment?.method !== 'string' || !payment.method.length || !Number.isSafeInteger(payment.amountMinor)) continue
    sums[payment.method] = (sums[payment.method] ?? 0) + payment.amountMinor
  }
  return sums
}

async function figuresOf(container: ExecArgs['container'], orders: Order[]) {
  const sessions = [...new Set(orders.flatMap(order => order.sessions))]
  return new Map(await Promise.all(sessions.map(async id => [id, await loadSessionFigures(container, id)] as const)))
}

function report(logger: { info(line: string): void }, orders: Order[], before: Map<string, Figures>, after: Map<string, Figures>) {
  for (const order of orders.filter(order => order.command)) {
    const paid = Object.entries(amounts(order.payments)).map(([method, amount]) => `${method} ${amount}`).join(', ')
    logger.info(`${PREFIX}: command ${order.command}, order ${order.id}, session ${order.session ?? 'none'}: ${paid || 'no payments'}`)
  }
  for (const id of [...before.keys()].sort()) {
    const ids = orders.filter(order => order.sessions.includes(id)).map(order => order.id).join(', ')
    const [b, a] = [before.get(id), after.get(id)]
    if (!b || !a) { logger.info(`${PREFIX}: session ${id} (not found): orders ${ids}`); continue }
    const methods = [...new Set(['cash', ...Object.keys(b.expected).sort(), ...Object.keys(a.expected).sort()])]
    const expected = methods.map(method => `${method} ${b.expected[method] ?? 0} -> ${a.expected[method] ?? 0}`).join(', ')
    logger.info(`${PREFIX}: session ${id} (${b.variance ? 'closed' : 'open'}): expected ${expected}; ` +
      `salesCount ${b.salesCount} -> ${a.salesCount}; orders ${ids}`)
  }
  const loose = orders.filter(order => !order.sessions.length).map(order => order.id)
  if (loose.length) logger.info(`${PREFIX}: no session: orders ${loose.join(', ')}`)
}
