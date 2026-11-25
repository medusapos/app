import type { ExecArgs } from '@medusajs/framework/types'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { currencyDecimals, minorToMajor } from '../workflows/tally-order-create/money'
import { baselineOrderRefund, listParkedRefunds } from '../workflows/tally-order-refund/admin'

export default async function tallyRefunds({ container, args }: ExecArgs) {
  const [action, orderId, medusaRefundId, flag] = args
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  if (action === 'list' && args.length === 1) {
    const { parked: rows, moved } = await listParkedRefunds(container)
    if (!rows.length) logger.info('no parked refunds')
    for (const row of rows) {
      const total = minorToMajor(Number(row.total_minor), currencyDecimals(row.currency_code))
      logger.info(`refund ${row.id}, command ${row.command_id}, order ${row.order_id} (#${row.display_id}), session ${row.session_id} (${row.session_status}, closure filed: ${row.closure_filed}), ${total} ${row.currency_code}, step ${row.step}, reason ${row.reason}, updated_at ${new Date(row.updated_at).toISOString()}`)
    }
    logger.info('moved refunds')
    for (const row of moved) {
      logger.info(`refund ${row.id}, command ${row.command_id}, order ${row.order_id} (#${row.display_id}), from session ${row.from_session_id}, to session ${row.to_session_id}, at ${row.at}, status ${row.status}`)
    }
    return
  }
  const handMade = flag === 'hand-made'
  const reason = args.slice(handMade ? 4 : 3).join(' ').trim()
  if (action !== 'baseline' || !orderId || !medusaRefundId || !reason || args.slice(1).some(arg => arg.startsWith('-'))) {
    throw new Error('Usage: tally-refunds.js list | baseline <orderId> <medusaRefundId> [hand-made] <reason words...>; nothing written')
  }
  await baselineOrderRefund(container, orderId, medusaRefundId, handMade, reason)
  logger.info(`tally refund baseline: order ${orderId}, Medusa refund ${medusaRefundId}`)
}
