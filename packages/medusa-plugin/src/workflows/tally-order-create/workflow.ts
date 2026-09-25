import { MedusaError, Modules } from '@medusajs/framework/utils'
import { createStep, createWorkflow, StepResponse, transform, when, WorkflowResponse, type StepExecutionContext } from '@medusajs/framework/workflows-sdk'
import {
  adjustInventoryLevelsStep, createInventoryLevelsStep,
  completeOrderWorkflow, convertDraftOrderWorkflow, createOrderFulfillmentWorkflow,
  createOrderPaymentCollectionWorkflow, createOrderWorkflow, markPaymentCollectionAsPaid,
  useQueryGraphStep, type CreateOrderWorkflowInput,
} from '@medusajs/medusa/core-flows'
import { TALLY_LEDGER_MODULE } from '../../modules/tally-ledger'
import type TallyLedgerModuleService from '../../modules/tally-ledger/service'
import type { StockTopUp } from './stock'
export type { StockTopUp } from './stock'
import { fulfillmentGroups, type OrderCreatePlan } from './plan'

export type TallyOrderCreateInput = {
  ledger: { commandId: string; claimToken: string } | null
  carriedTopUps: StockTopUp[]
  draftOrder: OrderCreatePlan['draftOrder']
  paymentAmount: number
  locationId: string
  shippingOptionId: string
  stockTopUps: Array<{ inventoryItemId: string; shortfall: number }>
  missingLevels: string[]
}

type RecordStockTopUps = {
  ledger: TallyOrderCreateInput['ledger']; applied: StockTopUp[]; pending: StockTopUp[] | null
  previous: { applied: StockTopUp[]; pending: StockTopUp[] | null }
}
async function recordStockTopUps(input: RecordStockTopUps, { container }: StepExecutionContext) {
  if (input.ledger && !await container.resolve<TallyLedgerModuleService>(TALLY_LEDGER_MODULE).recordStockTopUps(
    input.ledger.commandId, input.ledger.claimToken, input.applied, input.pending)) {
    throw new MedusaError(MedusaError.Types.CONFLICT, 'claim lost')
  }
  return new StepResponse(undefined, input)
}
async function restoreStockTopUps(data: RecordStockTopUps | undefined, { container }: StepExecutionContext) {
  if (data?.ledger) await container.resolve<TallyLedgerModuleService>(TALLY_LEDGER_MODULE).restoreStockTopUps(
    data.ledger.commandId, data.previous.applied, data.previous.pending)
}
// Two steps, one before and one after the top-up (ADR 0003 amendment, window 1).
const recordStockTopUpIntentStep = createStep('tally-record-stock-topup-intent', recordStockTopUps, restoreStockTopUps)
const recordStockTopUpAppliedStep = createStep('tally-record-stock-topup-applied', recordStockTopUps, restoreStockTopUps)
const takeBackStockStep = createStep('tally-take-back-stock', async (orderId: string, { container }) => {
  const orders = container.resolve(Modules.ORDER)
  const order = await orders.retrieveOrder(orderId)
  const topUps = order.metadata!.tally_stock_topups as StockTopUp[]
  const adjusted = order.metadata!.tally_stock_take_back_started !== true
  if (adjusted) await orders.updateOrders(orderId, { metadata: { ...order.metadata, tally_stock_take_back_started: true } })
  if (adjusted) await container.resolve(Modules.LOCKING).execute(Array.from(new Set(topUps.map(topUp => topUp.inventory_item_id))), async () => {
    await container.resolve(Modules.INVENTORY).adjustInventory(topUps.map(topUp => ({
      inventoryItemId: topUp.inventory_item_id, locationId: topUp.location_id, adjustment: -topUp.shortfall,
    })))
  })
  await orders.updateOrders(orderId, { metadata: { ...order.metadata, tally_stock_take_back_started: true, tally_stock_topups_reversed: true } })
  return new StepResponse(undefined, { orderId, topUps, adjusted, started: order.metadata!.tally_stock_take_back_started ?? null,
    flag: order.metadata!.tally_stock_topups_reversed ?? null })
}, async (data, { container }) => {
  if (!data) return
  if (data.adjusted) await container.resolve(Modules.LOCKING).execute(Array.from(new Set(data.topUps.map(topUp => topUp.inventory_item_id))), async () => {
    await container.resolve(Modules.INVENTORY).adjustInventory(data.topUps.map(topUp => ({
      inventoryItemId: topUp.inventory_item_id, locationId: topUp.location_id, adjustment: topUp.shortfall,
    })))
  })
  const orders = container.resolve(Modules.ORDER)
  const order = await orders.retrieveOrder(data.orderId)
  await orders.updateOrders(data.orderId, { metadata: { ...order.metadata, tally_stock_take_back_started: data.started, tally_stock_topups_reversed: data.flag } })
})
export const takeBackStockWorkflow = createWorkflow('tally-take-back-stock', function (input: { orderId: string }) {
  takeBackStockStep(input.orderId)
  return new WorkflowResponse(undefined)
})

export const tallyOrderCreateWorkflow = createWorkflow('tally-order-create', function (input: TallyOrderCreateInput) {
  when('has-missing-stock-levels', { input }, ({ input }) => input.missingLevels.length > 0).then(() => {
    createInventoryLevelsStep(transform({ input }, ({ input }) => input.missingLevels.map(inventory_item_id => ({
      inventory_item_id, location_id: input.locationId, stocked_quantity: 0,
    }))))
  })
  when('has-stock-topups', { input }, ({ input }) => input.stockTopUps.length > 0).then(() => {
    const pending = transform({ input }, ({ input }) => input.stockTopUps.map(topUp => ({
      inventory_item_id: topUp.inventoryItemId, location_id: input.locationId, shortfall: topUp.shortfall,
    })))
    recordStockTopUpIntentStep({ ledger: input.ledger, applied: input.carriedTopUps, pending,
      previous: { applied: input.carriedTopUps, pending: null } })
    adjustInventoryLevelsStep(transform({ input }, ({ input }) => input.stockTopUps.map(topUp => ({
      inventory_item_id: topUp.inventoryItemId, location_id: input.locationId, adjustment: topUp.shortfall,
    }))))
    recordStockTopUpAppliedStep({ ledger: input.ledger,
      applied: input.draftOrder.metadata.tally_stock_topups as StockTopUp[], pending: null,
      previous: { applied: input.carriedTopUps, pending } })
  })
  // Medusa fills variant-backed item titles from the product, although its DTO requires title.
  const draft = createOrderWorkflow.runAsStep({ input: input.draftOrder as unknown as CreateOrderWorkflowInput })
  convertDraftOrderWorkflow.runAsStep({ input: { id: draft.id } })
  // Medusa cannot capture 0, so a sale discounted to 0 (ADR-062) completes without a payment collection.
  when('has-payment', { input }, ({ input }) => input.paymentAmount > 0).then(() => {
    const collections = createOrderPaymentCollectionWorkflow.runAsStep({
      input: { order_id: draft.id, amount: input.paymentAmount },
    })
    const paymentInput = transform({ draft, collections }, ({ draft, collections }) => ({
      order_id: draft.id, payment_collection_id: collections[0].id,
    }))
    markPaymentCollectionAsPaid.runAsStep({ input: paymentInput })
  })
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
  when('has-stock-to-take-back', { input }, ({ input }) => ((input.draftOrder.metadata.tally_stock_topups as StockTopUp[] | undefined) ?? []).length > 0).then(() => {
    takeBackStockStep(draft.id)
  })
  completeOrderWorkflow.runAsStep({ input: { orderIds: [draft.id] } })
  return new WorkflowResponse({ orderId: draft.id })
})
