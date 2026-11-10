import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import { buildReceiptNotification, isTillOrder, parseReceiptEmailBody } from '../../receipt-email'

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const parsed = parseReceiptEmailBody(req.body)
  if (!parsed.ok) return res.status(400).json({ code: 'invalid_payload', message: parsed.message })
  const { value } = parsed
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data: [order] } = await query.graph({
    entity: 'order',
    fields: ['id', 'display_id', 'currency_code', 'created_at', 'is_draft_order', 'metadata', 'total', 'raw_total', 'raw_subtotal',
      'raw_tax_total', 'raw_discount_total', 'raw_shipping_total', 'items.id', 'items.title', 'items.variant_title',
      'items.variant_sku', 'items.raw_quantity', 'items.raw_unit_price', 'items.raw_total'],
    filters: { id: req.params.id },
  })
  if (!order || !isTillOrder(order)) {
    return res.status(404).json({ code: 'order_not_found', message: 'This order is not known to the store.' })
  }

  // Providers are synced from config at boot. No public module method reads them, and sending
  // without a provider writes a failed notification and throws the same plain Error as a send failure.
  if (!req.scope.hasRegistration(Modules.NOTIFICATION) || !await req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION)('notification_provider')
    .where({ is_enabled: true }).whereNull('deleted_at').whereRaw('? = any(channels)', ['email']).first()) {
    return res.status(503).json({
      code: 'receipt_email_unavailable', message: "This store has no email provider set up, so it can't email receipts.",
    })
  }

  let notification
  try {
    notification = await req.scope.resolve(Modules.NOTIFICATION).createNotifications(buildReceiptNotification(order, value.email))
  } catch (error) {
    const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
    const message = error instanceof Error ? error.message : String(error)
    logger.error(`Receipt email for order ${order.id} failed: ${message}`)
    return res.status(502).json({ code: 'receipt_email_failed', message: "The store's email provider didn't send the receipt." })
  }
  // saveToBilling is not applied yet: updating the order email can create or re-link a customer.
  return res.status(202).json({ notificationId: notification.id, savedToBilling: false })
}
