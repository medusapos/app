import { createWorkflow, transform, when, WorkflowResponse } from '@medusajs/framework/workflows-sdk'
import {
  completeOrderWorkflow, convertDraftOrderWorkflow, createOrderFulfillmentWorkflow,
  createOrderPaymentCollectionWorkflow, createOrderWorkflow, markPaymentCollectionAsPaid,
  useQueryGraphStep, type CreateOrderWorkflowInput,
} from '@medusajs/medusa/core-flows'
import { fulfillmentGroups, type OrderCreatePlan } from './plan'

export type TallyOrderCreateInput = {
  draftOrder: OrderCreatePlan['draftOrder']
  paymentAmount: number
  locationId: string
  shippingOptionId: string
}

export const tallyOrderCreateWorkflow = createWorkflow('tally-order-create', function (input: TallyOrderCreateInput) {
  // Medusa fills variant-backed item titles from the product, although its DTO requires title.
  const draft = createOrderWorkflow.runAsStep({ input: input.draftOrder as unknown as CreateOrderWorkflowInput })
  convertDraftOrderWorkflow.runAsStep({ input: { id: draft.id } })
  const collections = createOrderPaymentCollectionWorkflow.runAsStep({
    input: { order_id: draft.id, amount: input.paymentAmount },
  })
  const paymentInput = transform({ draft, collections }, ({ draft, collections }) => ({
    order_id: draft.id, payment_collection_id: collections[0].id,
  }))
  markPaymentCollectionAsPaid.runAsStep({ input: paymentInput })
  const { data: orders } = useQueryGraphStep({
    entity: 'order', fields: ['id', 'items.id', 'items.quantity', 'items.detail.quantity', 'items.requires_shipping'],
    filters: { id: draft.id },
  })
  const groups = transform({ orders }, ({ orders }) => fulfillmentGroups(orders[0].items))
  when('has-first-fulfillment', { groups }, ({ groups }) => groups.length > 0).then(() => {
    const fulfillment = transform({ input, draft, groups }, ({ input, draft, groups }) => ({
      order_id: draft.id, items: groups[0], location_id: input.locationId,
      shipping_option_id: input.shippingOptionId, no_notification: true,
    }))
    createOrderFulfillmentWorkflow.runAsStep({ input: fulfillment }).config({ name: 'fulfill-first-group' })
  })
  when('has-second-fulfillment', { groups }, ({ groups }) => groups.length > 1).then(() => {
    const fulfillment = transform({ input, draft, groups }, ({ input, draft, groups }) => ({
      order_id: draft.id, items: groups[1], location_id: input.locationId,
      shipping_option_id: input.shippingOptionId, no_notification: true,
    }))
    createOrderFulfillmentWorkflow.runAsStep({ input: fulfillment }).config({ name: 'fulfill-second-group' })
  })
  completeOrderWorkflow.runAsStep({ input: { orderIds: [draft.id] } })
  return new WorkflowResponse({ orderId: draft.id })
})
