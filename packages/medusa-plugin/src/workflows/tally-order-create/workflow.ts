import { randomUUID } from 'node:crypto'
import { ContainerRegistrationKeys, MedusaError, Modules } from '@medusajs/framework/utils'
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
import { currencyDecimals, minorToMajor } from './money'
import type { CouponWrite } from '../tally-coupons/order-coupons'
import { CouponUsageError } from '../tally-coupons/coupon-usage-error'

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
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const order = await orders.retrieveOrder(orderId)
  const topUps = order.metadata!.tally_stock_topups as StockTopUp[]
  const started = order.metadata!.tally_stock_take_back_started ?? null
  const adjusted = started !== true
  // attempt keys the compensation's progress marker to this run's data.
  const data = { orderId, topUps, adjusted, started, flag: order.metadata!.tally_stock_topups_reversed ?? null, attempt: randomUUID() }
  if (adjusted) await orders.updateOrders(orderId, { metadata: { ...order.metadata, tally_stock_take_back_started: true } })
  let took = false
  if (adjusted) await container.resolve(Modules.LOCKING).execute(Array.from(new Set(topUps.map(topUp => topUp.inventory_item_id))), async () => {
    await container.resolve(Modules.INVENTORY).adjustInventory(topUps.map(topUp => ({
      inventoryItemId: topUp.inventory_item_id, locationId: topUp.location_id, adjustment: -topUp.shortfall,
    })))
    took = true
  }).catch(async (error: unknown) => {
    // A throw after the adjustment (the unlock) still succeeds, so neither this step nor the top-up is compensated twice.
    if (took) return logger.error(`tally take-back: order ${orderId} took its stock top-up back, but the lock release failed: ${(error as Error).message}`)
    // A throw before it took nothing back, so the retry adjusts.
    await orders.updateOrders(orderId, { metadata: { ...order.metadata, tally_stock_take_back_started: started } })
    throw error
  })
  try {
    await orders.updateOrders(orderId, { metadata: { ...order.metadata, tally_stock_take_back_started: true, tally_stock_topups_reversed: true } })
  } catch (error) {
    if (!took) throw error
    // A failure after the adjustment carries the compensation data, so Medusa puts the stock back exactly once (ADR 0003).
    const message = `tally take-back: order ${orderId} took its stock top-up back, but the reversed marker write failed: ${(error as Error).message}`
    logger.error(message)
    return StepResponse.permanentFailure(message, data)
  }
  return new StepResponse(undefined, data)
}, async (data, { container }) => {
  if (!data) return
  const orders = container.resolve(Modules.ORDER)
  let took = false
  let restored = false
  // The read, the marker check, the re-adjustment and the restore all run under the lock, so the restore never
  // overwrites metadata written while it waited.
  await container.resolve(Modules.LOCKING).execute(Array.from(new Set(data.topUps.map(topUp => topUp.inventory_item_id))), async () => {
    const { metadata } = await orders.retrieveOrder(data.orderId)
    // The restore carries this run's progress marker, so a rerun, or a throw after the re-adjustment, never re-adjusts.
    if (data.adjusted && metadata?.tally_stock_take_back_compensated !== data.attempt) {
      await container.resolve(Modules.INVENTORY).adjustInventory(data.topUps.map(topUp => ({
        inventoryItemId: topUp.inventory_item_id, locationId: topUp.location_id, adjustment: topUp.shortfall,
      })))
      took = true
    }
    await orders.updateOrders(data.orderId, { metadata: { ...metadata, tally_stock_take_back_compensated: data.attempt,
      tally_stock_take_back_started: data.started, tally_stock_topups_reversed: data.flag } })
    restored = true
  }).catch((error: unknown) => {
    // Only a throw before any write propagates: a throwing compensation could stop the compensations after it.
    if (!took && !restored) throw error
    container.resolve(ContainerRegistrationKeys.LOGGER).error(took
      ? `tally take-back compensation: order ${data.orderId} put its stock top-up back, but a later write or the lock release failed: ${(error as Error).message}`
      : `tally take-back compensation: order ${data.orderId} restored its markers, but the lock release failed: ${(error as Error).message}`)
  })
})
type Adjusted = Array<{ adjustments?: Array<{ id: string; promotion_id?: string | null }> | null }> | null | undefined
// The till's coupon adjustments survive resume; its POS discounts have no promotion.
const promoted = (rows: Adjusted, ids: Set<string>) => (rows ?? []).flatMap(row => row.adjustments ?? []).filter(row => row.promotion_id && !ids.has(row.promotion_id)).map(row => row.id)
type PromotionChanges = { orderId: string; items: string[]; shipping: string[]; created: string[]; links: string[] }
async function undoPromotionAdjustments(data: PromotionChanges | undefined, { container }: StepExecutionContext) {
  if (!data) return
  const orders = container.resolve(Modules.ORDER)
  if (data.items.length) await orders.restoreOrderLineItemAdjustments(data.items)
  if (data.shipping.length) await orders.restoreOrderShippingMethodAdjustments(data.shipping)
  if (data.created.length) await orders.softDeleteOrderLineItemAdjustments(data.created)
  for (const promotion_id of data.links) await container.resolve(ContainerRegistrationKeys.LINK).dismiss({
    [Modules.ORDER]: { order_id: data.orderId }, [Modules.PROMOTION]: { promotion_id },
  })
}
const promotionAdjustmentsStep = createStep('tally-promotion-adjustments', async (orderId: string, context) => {
  const { container } = context
  const orders = container.resolve(Modules.ORDER)
  const order = await orders.retrieveOrder(orderId, { relations: ['items.adjustments', 'shipping_methods.adjustments'] })
  const writes = (order.metadata?.tally_coupons ?? []) as CouponWrite[], ids = new Set(writes.map(write => write.promotionId))
  const { data: links } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({ entity: 'order_promotion', filters: { order_id: orderId }, fields: ['promotion_id'] })
  const data: PromotionChanges = { orderId, items: promoted(order.items, ids), shipping: promoted(order.shipping_methods, ids), created: [], links: [] }
  try {
    if (data.items.length) await orders.softDeleteOrderLineItemAdjustments(data.items)
    if (data.shipping.length) await orders.softDeleteOrderShippingMethodAdjustments(data.shipping)
    for (const write of writes) {
      for (const line of write.lines) {
        const item = order.items?.find(item => item.metadata?.tally_line_uuid === line.lineId)
        if (!item) throw new Error(`coupon line missing: ${line.lineId}`)
        if (item.adjustments?.some(adjustment => adjustment.promotion_id === write.promotionId)) continue
        const [adjustment] = await orders.createOrderLineItemAdjustments([{
          item_id: item.id, code: write.promotionCode, promotion_id: write.promotionId,
          amount: minorToMajor(line.amountMinor, currencyDecimals(order.currency_code)), is_tax_inclusive: line.taxInclusive, description: 'Coupon',
        }])
        data.created.push(adjustment.id)
        item.adjustments = [...(item.adjustments ?? []), adjustment]
      }
      if (!links.some(link => link.promotion_id === write.promotionId) && !data.links.includes(write.promotionId)) {
        await container.resolve(ContainerRegistrationKeys.LINK).create({ [Modules.ORDER]: { order_id: orderId }, [Modules.PROMOTION]: { promotion_id: write.promotionId } })
        data.links.push(write.promotionId)
      }
    }
    return new StepResponse(undefined, data)
  } catch (error) {
    await undoPromotionAdjustments(data, context)
    throw error
  }
}, undoPromotionAdjustments)
type CouponUsage = { orderId: string; marker: unknown; registered: CouponWrite[]; context: { customer_id: string | null; customer_email: string | null } }
async function undoCouponUsage(data: CouponUsage | undefined, { container }: StepExecutionContext) {
  if (!data) return
  for (const write of data.registered) await container.resolve(Modules.PROMOTION).revertUsage(
    write.actions.map(action => ({ action: 'addItemAdjustment', code: write.promotionCode, amount: action.amount })), data.context)
  const orders = container.resolve(Modules.ORDER), order = await orders.retrieveOrder(data.orderId)
  await orders.updateOrders(data.orderId, { metadata: { ...order.metadata, tally_coupon_usage_registered: data.marker } })
}
const couponUsageStep = createStep('tally-register-coupon-usage', async ({ orderId, onLimit }: { orderId: string; onLimit: 'refuse' | 'log' }, context) => {
  const { container } = context, orders = container.resolve(Modules.ORDER), order = await orders.retrieveOrder(orderId)
  const writes = (order.metadata?.tally_coupons ?? []) as CouponWrite[]
  if (!writes.length || order.metadata?.tally_coupon_usage_registered === true) return new StepResponse(undefined)
  const data: CouponUsage = { orderId, marker: order.metadata?.tally_coupon_usage_registered ?? null, registered: [],
    context: { customer_id: order.customer_id ?? null, customer_email: order.email ?? null } }
  // Mark first so a crash under-counts usage instead of consuming a coupon twice.
  await orders.updateOrders(orderId, { metadata: { ...order.metadata, tally_coupon_usage_registered: true } })
  for (const write of writes) {
    try {
      await container.resolve(Modules.PROMOTION).registerUsage(
        write.actions.map(action => ({ action: 'addItemAdjustment', code: write.promotionCode, amount: action.amount })), data.context)
      data.registered.push(write)
    } catch (error) {
      await undoCouponUsage(data, context)
      const storeCode = MedusaError.isMedusaError(error) && error.type === MedusaError.Types.NOT_ALLOWED
        ? error.message === 'Promotion usage exceeds the limit.' ? 'limit_reached'
          : error.message === 'Promotion usage exceeds the budget limit.' ? 'budget_exceeded' : null : null
      if (!storeCode) throw error
      if (onLimit === 'refuse') throw new CouponUsageError(write.couponCode, storeCode)
      container.resolve(ContainerRegistrationKeys.LOGGER).error(`tally coupon usage: order ${orderId}, coupon ${write.couponCode}: ${error.message}`)
      return new StepResponse(undefined)
    }
  }
  return new StepResponse(undefined, data)
}, undoCouponUsage)
export const takeBackStockWorkflow = createWorkflow('tally-take-back-stock', function (input: { orderId: string }) {
  takeBackStockStep(input.orderId)
  return new WorkflowResponse(undefined)
})
export const couponResumeWorkflow = createWorkflow('tally-resume-promotion-adjustments', function (input: { orderId: string }) {
  promotionAdjustmentsStep(input.orderId)
  couponUsageStep({ orderId: input.orderId, onLimit: 'log' })
  return new WorkflowResponse(undefined)
})

// In Medusa 2.21, when().then() re-registers a step renamed by .config({ name }) under its pre-rename handler, which
// loses its compensation, so we never rename a step inside when: each fulfilment group runs as its own workflow (ADR 0003).
type FulfillmentInput = Parameters<typeof createOrderFulfillmentWorkflow.runAsStep>[0]['input']
const fulfillFirstGroupWorkflow = createWorkflow('tally-fulfill-first-group', function (input: FulfillmentInput) {
  return new WorkflowResponse(createOrderFulfillmentWorkflow.runAsStep({ input }))
})
const fulfillSecondGroupWorkflow = createWorkflow('tally-fulfill-second-group', function (input: FulfillmentInput) {
  return new WorkflowResponse(createOrderFulfillmentWorkflow.runAsStep({ input }))
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
  // createOrderWorkflow's promotion refresh applies the store's automatic promotions, so their adjustments come off (#290).
  // Till coupons replace automatic discounts so the stored total matches the till.
  promotionAdjustmentsStep(draft.id)
  couponUsageStep({ orderId: draft.id, onLimit: 'refuse' })
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
    fulfillFirstGroupWorkflow.runAsStep({ input: fulfillment })
  })
  when('has-second-fulfillment', { groups }, ({ groups }) => groups.length > 1).then(() => {
    const fulfillment = transform({ input, draft, groups }, ({ input, draft, groups }) => ({
      order_id: draft.id, items: groups[1], location_id: input.locationId,
      shipping_option_id: input.shippingOptionId, no_notification: true,
    }))
    fulfillSecondGroupWorkflow.runAsStep({ input: fulfillment })
  })
  when('has-stock-to-take-back', { input }, ({ input }) => ((input.draftOrder.metadata.tally_stock_topups as StockTopUp[] | undefined) ?? []).length > 0).then(() => {
    takeBackStockStep(draft.id)
  })
  completeOrderWorkflow.runAsStep({ input: { orderIds: [draft.id] } })
  return new WorkflowResponse({ orderId: draft.id })
})
