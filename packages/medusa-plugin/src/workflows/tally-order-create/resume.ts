import type { MedusaContainer } from '@medusajs/framework/types'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import {
  completeOrderWorkflow, convertDraftOrderWorkflow, createOrderFulfillmentWorkflow,
  createOrderPaymentCollectionWorkflow, markPaymentCollectionAsPaid,
} from '@medusajs/medusa/core-flows'
import { fulfillmentGroups } from './plan'
import { takeBackStockWorkflow } from './workflow'

export async function resumeOrderCreate(container: MedusaContainer, orderId: string,
  paymentAmount: number, locationId: string, shippingOptionId: string) {
  const { data: [order] } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({
    entity: 'order', filters: { id: orderId }, fields: ['id', 'status', 'is_draft_order', 'metadata',
      'payment_collections.id', 'payment_collections.status', 'fulfillments.id', 'fulfillments.canceled_at',
      'items.id', 'items.quantity', 'items.requires_shipping', 'items.detail.quantity', 'items.detail.fulfilled_quantity'],
  })
  if (order.status === 'completed') return
  if (order.is_draft_order) await convertDraftOrderWorkflow(container).run({ input: { id: orderId } })
  let collections = order.payment_collections
  if (!collections.length) {
    const { result } = await createOrderPaymentCollectionWorkflow(container).run({ input: { order_id: orderId, amount: paymentAmount } })
    collections = result
  }
  for (const collection of collections) {
    if (collection.status !== 'completed') await markPaymentCollectionAsPaid(container).run({
      input: { order_id: orderId, payment_collection_id: collection.id },
    })
  }
  const remaining = order.items.map(item => ({ ...item,
    quantity: Number(item.quantity) - Number(item.detail.fulfilled_quantity),
  })).filter(item => item.quantity > 0)
  for (const items of fulfillmentGroups(remaining)) {
    await createOrderFulfillmentWorkflow(container).run({ input: {
      order_id: orderId, items, location_id: locationId, shipping_option_id: shippingOptionId, no_notification: true,
    } })
  }
  if (order.metadata?.tally_stock_topups && !order.metadata.tally_stock_topups_reversed) {
    await takeBackStockWorkflow(container).run({ input: { orderId } })
  }
  await completeOrderWorkflow(container).run({ input: { orderIds: [orderId] } })
}
