import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { MedusaContainer } from '@medusajs/framework/types'
import { ContainerRegistrationKeys, MedusaError, Modules } from '@medusajs/framework/utils'
import { createStep, createWorkflow, StepResponse, transform, when, WorkflowResponse } from '@medusajs/framework/workflows-sdk'
import { convertDraftOrderWorkflow, createOrderWorkflow, type CreateOrderWorkflowInput } from '@medusajs/medusa/core-flows'
import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import type { CommandEnvelope, OrderCreatePayload } from '@tallyui/core' with { 'resolution-mode': 'import' }
import feeFixture from '../../src/workflows/tally-order-create/__fixtures__/order-create-v5-fee.json'
import { planOrderCreate } from '../../src/workflows/tally-order-create/plan'
import { seed } from './seed'

type Payload = OrderCreatePayload & { display: NonNullable<OrderCreatePayload['display']> }
type ProbeInput = { draftOrder: CreateOrderWorkflowInput; promotionId: string; code: string; amount: number; fail: boolean }

// Medusa 2.21.0 does not export registerUsageStep; copy its usage and compensation contract.
const registerUsageStep = createStep('tally-probe-register-usage', async (data: {
  computedActions: Array<{ amount: number; code: string }>
  registrationContext: { customer_id: string | null; customer_email: string | null }
}, { container }) => {
  if (!data.computedActions.length) {
    return new StepResponse(null, { computedActions: [], registrationContext: data.registrationContext })
  }
  const promotionModule = container.resolve(Modules.PROMOTION)
  await promotionModule.registerUsage(data.computedActions, data.registrationContext)
  return new StepResponse(null, data)
}, async (revertData, { container }) => {
  if (!revertData?.computedActions.length) return
  const promotionModule = container.resolve(Modules.PROMOTION)
  await promotionModule.revertUsage(revertData.computedActions, revertData.registrationContext)
})

const couponAdjustmentStep = createStep('tally-probe-coupon-adjustment', async (
  input: { orderId: string; promotionId: string; code: string; amount: number }, { container },
) => {
  const orders = container.resolve(Modules.ORDER)
  const order = await orders.retrieveOrder(input.orderId, { relations: ['items'] })
  const [adjustment] = await orders.createOrderLineItemAdjustments([{
    item_id: order.items![0].id, code: input.code, promotion_id: input.promotionId,
    amount: input.amount, is_tax_inclusive: false, description: 'Coupon',
  }])
  const link = { [Modules.ORDER]: { order_id: input.orderId }, [Modules.PROMOTION]: { promotion_id: input.promotionId } }
  await container.resolve(ContainerRegistrationKeys.LINK).create(link)
  return new StepResponse(undefined, { adjustmentId: adjustment.id, link })
}, async (data, { container }) => {
  if (!data) return
  await container.resolve(Modules.ORDER).softDeleteOrderLineItemAdjustments([data.adjustmentId])
  await container.resolve(ContainerRegistrationKeys.LINK).dismiss(data.link)
})

const failStep = createStep('tally-probe-fail', async () => {
  throw new Error('probe failure after usage')
})

const couponOrderWorkflow = createWorkflow('tally-probe-coupon-order', (input: ProbeInput) => {
  const draft = createOrderWorkflow.runAsStep({ input: input.draftOrder })
  couponAdjustmentStep({ orderId: draft.id, promotionId: input.promotionId, code: input.code, amount: input.amount })
  convertDraftOrderWorkflow.runAsStep({ input: { id: draft.id } })
  registerUsageStep(transform({ input }, ({ input }) => ({
    computedActions: [{ code: input.code, amount: input.amount }],
    registrationContext: { customer_id: null, customer_email: null },
  })))
  when('tally-probe-should-fail', { input }, ({ input }) => input.fail).then(() => {
    failStep()
  })
  return new WorkflowResponse(draft.id)
})

jest.setTimeout(180000)

medusaIntegrationTestRunner({
  cwd: path.resolve(__dirname, '../plugin-app'),
  testSuite: ({ getContainer }) => {
    let container: MedusaContainer
    let data: Awaited<ReturnType<typeof seed>>
    beforeAll(async () => {
      container = getContainer()
      data = await seed(container)
    })

    // One v7 sale of variant A: 10.00 net, 19% tax, no fee, shipping or discount.
    function command() {
      const sale = structuredClone(feeFixture) as unknown as CommandEnvelope<Payload>
      const payload = sale.payload
      sale.id = randomUUID()
      sale.version = 7
      sale.createdAt = payload.createdAt = new Date().toISOString()
      payload.clientOrderId = randomUUID()
      delete payload.customer
      delete payload.sessionId
      delete payload.fees
      delete payload.display.fees
      const line = payload.lines[0]
      Object.assign(line, { clientLineId: randomUUID(), variantId: data.variantA, unitPriceMinor: 1000 })
      payload.display.lines = [{ clientLineId: line.clientLineId, amountMinor: 1000, discounts: [] }]
      Object.assign(payload, { subtotalMinor: 1000, taxMinor: 190, totalMinor: 1190 })
      payload.payments[0].amountMinor = 1190
      Object.assign(payload.display, { subtotalMinor: 1000, discountMinor: 0, taxMinor: 190, totalMinor: 1190 })
      payload.taxByRate = [{ ratePpm: 190000, netMinor: 1000, taxMinor: 190, grossMinor: 1190 }]
      payload.note = 'promotion contract probe'
      return sale
    }

    function draftOrder() {
      const sale = command()
      const planned = planOrderCreate(sale.payload, { customer: null, commandId: sale.id, salesChannelId: data.channelId,
        region: { id: data.regionId, currency_code: 'eur', country_codes: ['de', 'dk'] },
        location: { id: data.berlinId, address: { address_1: 'Alexanderplatz 1', city: 'Berlin', country_code: 'de', postal_code: '10178' } },
        variants: { [data.variantA]: { id: data.variantA } },
      }, sale.version)
      if (!planned.ok) throw new Error('Expected draft plan')
      return planned.plan.draftOrder as unknown as CreateOrderWorkflowInput
    }

    it('probe: a coupon adjustment written before convert survives it and counts in the totals; usage and the link are recorded', async () => {
      const promotions = container.resolve(Modules.PROMOTION)
      const promotion = await promotions.createPromotions({
        code: 'COUPON1', type: 'standard', status: 'active', is_automatic: false, limit: 5,
        application_method: { type: 'fixed', target_type: 'items', allocation: 'across', value: 1, currency_code: 'eur' },
      })
      const { result: controlDraft } = await createOrderWorkflow(container).run({ input: draftOrder() })
      await convertDraftOrderWorkflow(container).run({ input: { id: controlDraft.id } })
      const { result: orderId } = await couponOrderWorkflow(container).run({ input: {
        draftOrder: draftOrder(), promotionId: promotion.id, code: 'COUPON1', amount: 1, fail: false,
      } })
      const query = container.resolve(ContainerRegistrationKeys.QUERY)
      const { data: [control] } = await query.graph({
        entity: 'order', filters: { id: controlDraft.id }, fields: ['id', 'total'],
      })
      const { data: [order] } = await query.graph({
        entity: 'order', filters: { id: orderId }, fields: ['id', 'is_draft_order', 'total', 'tax_total', 'items.adjustments.*'],
      })
      const { data: links } = await query.graph({
        entity: 'order_promotion', filters: { order_id: orderId }, fields: ['promotion_id'],
      })
      const { used } = await promotions.retrievePromotion(promotion.id)
      const adjustments = order.items.flatMap(item => item!.adjustments ?? [])
        .map(({ code, promotion_id, amount }) => ({ code, promotion_id, amount: Number(amount) }))
      expect(order.is_draft_order).toBe(false)
      expect(adjustments).toEqual([{ code: 'COUPON1', promotion_id: promotion.id, amount: 1 }])
      expect(Math.round(Number(order.total) * 100)).toBe(1071)
      expect(Math.round(Number(control.total) * 100)).toBe(1190)
      expect(links).toEqual([expect.objectContaining({ promotion_id: promotion.id })])
      expect(Number(used)).toBe(1)
    })

    it('probe: a failure after registerUsageStep reverts the usage and leaves no link', async () => {
      const promotions = container.resolve(Modules.PROMOTION)
      const promotion = await promotions.createPromotions({
        code: 'COUPON2', type: 'standard', status: 'active', is_automatic: false, limit: 5,
        application_method: { type: 'fixed', target_type: 'items', allocation: 'across', value: 1, currency_code: 'eur' },
      })
      let error: unknown
      try {
        await couponOrderWorkflow(container).run({ input: {
          draftOrder: draftOrder(), promotionId: promotion.id, code: 'COUPON2', amount: 1, fail: true,
        } })
      } catch (caught) { error = caught }
      const { used } = await promotions.retrievePromotion(promotion.id)
      const { data: links } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({
        entity: 'order_promotion', filters: { promotion_id: promotion.id }, fields: ['order_id', 'promotion_id'],
      })
      expect(error).toMatchObject({ message: expect.stringContaining('probe failure after usage') })
      expect(Number(used)).toBe(0)
      expect(links).toEqual([])
    })

    it('probe: a used-up limit throws not_allowed and keeps usage', async () => {
      const promotions = container.resolve(Modules.PROMOTION)
      const promotion = await promotions.createPromotions({
        code: 'COUPON3', type: 'standard', status: 'active', is_automatic: false, limit: 1,
        application_method: { type: 'fixed', target_type: 'items', allocation: 'across', value: 1, currency_code: 'eur' },
      })
      await couponOrderWorkflow(container).run({ input: {
        draftOrder: draftOrder(), promotionId: promotion.id, code: 'COUPON3', amount: 1, fail: false,
      } })
      const first = await promotions.retrievePromotion(promotion.id)
      expect(Number(first.used)).toBe(1)
      let error: unknown
      try {
        await couponOrderWorkflow(container).run({ input: {
          draftOrder: draftOrder(), promotionId: promotion.id, code: 'COUPON3', amount: 1, fail: false,
        } })
      } catch (caught) { error = caught }
      const { used } = await promotions.retrievePromotion(promotion.id)
      expect(error).toMatchObject({ message: 'Promotion usage exceeds the limit.', type: MedusaError.Types.NOT_ALLOWED })
      expect(Number(used)).toBe(1)
    })

    it('probe: a used-up usage budget throws not_allowed and keeps usage', async () => {
      const promotions = container.resolve(Modules.PROMOTION)
      const [campaign] = await promotions.createCampaigns([{ name: 'Coupon probe', campaign_identifier: 'coupon-probe',
        budget: { type: 'usage', limit: 1 } }])
      const promotion = await promotions.createPromotions({
        code: 'COUPON4', type: 'standard', status: 'active', is_automatic: false, campaign_id: campaign.id,
        application_method: { type: 'fixed', target_type: 'items', allocation: 'across', value: 1, currency_code: 'eur' },
      })
      await couponOrderWorkflow(container).run({ input: {
        draftOrder: draftOrder(), promotionId: promotion.id, code: 'COUPON4', amount: 1, fail: false,
      } })
      const first = await promotions.retrieveCampaign(campaign.id, { relations: ['budget'] })
      expect(Number(first.budget!.used)).toBe(1)
      let error: unknown
      try {
        await couponOrderWorkflow(container).run({ input: {
          draftOrder: draftOrder(), promotionId: promotion.id, code: 'COUPON4', amount: 1, fail: false,
        } })
      } catch (caught) { error = caught }
      const { budget } = await promotions.retrieveCampaign(campaign.id, { relations: ['budget'] })
      expect(error).toMatchObject({ message: 'Promotion usage exceeds the budget limit.', type: MedusaError.Types.NOT_ALLOWED })
      expect(Number(budget!.used)).toBe(1)
    })
  },
})
