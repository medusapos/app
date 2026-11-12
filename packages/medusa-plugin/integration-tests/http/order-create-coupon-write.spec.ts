import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { MedusaContainer, PromotionDTO } from '@medusajs/framework/types'
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import { createOrderWorkflow, type CreateOrderWorkflowInput } from '@medusajs/medusa/core-flows'
import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import type { CommandEnvelope, OrderCreatePayload } from '@tallyui/core' with { 'resolution-mode': 'import' }
import { TALLY_LEDGER_MODULE } from '../../src/modules/tally-ledger'
import type TallyLedgerModuleService from '../../src/modules/tally-ledger/service'
import { orderCoupons } from '../../src/workflows/tally-coupons/order-coupons'
import { executeOrderCreate, type ExecuteOutcome } from '../../src/workflows/tally-order-create/execute'
import { planOrderCreate } from '../../src/workflows/tally-order-create/plan'
import inclusive from '../../src/workflows/tally-order-create/__fixtures__/order-create-coupon-envelopes-2026-11-12/inclusive-coupon.json'
import { seed } from './seed'

type Payload = OrderCreatePayload & {
  coupons: NonNullable<OrderCreatePayload['coupons']>
  display: NonNullable<OrderCreatePayload['display']>
}

jest.setTimeout(180000)

medusaIntegrationTestRunner({
  cwd: path.resolve(__dirname, '../plugin-app'),
  testSuite: ({ getContainer }) => {
    let container: MedusaContainer
    let ledger: TallyLedgerModuleService
    let data: Awaited<ReturnType<typeof seed>>
    beforeAll(async () => {
      container = getContainer()
      ledger = container.resolve(TALLY_LEDGER_MODULE)
      data = await seed(container)
    })
    afterEach(() => jest.restoreAllMocks())

    function command(fixture: typeof inclusive, promotion?: PromotionDTO) {
      const sale = structuredClone(fixture) as unknown as CommandEnvelope<Payload>
      const payload = sale.payload
      sale.id = randomUUID()
      sale.createdAt = payload.createdAt = new Date().toISOString()
      payload.clientOrderId = randomUUID()
      payload.payments[0].clientPaymentId = randomUUID()
      payload.lines[0].clientLineId = payload.display.lines[0].clientLineId = randomUUID()
      payload.lines[0].variantId = data.variantA
      if (promotion) {
        payload.coupons[0].code = payload.display.coupons![0].code = promotion.code!
        payload.coupons[0].couponId = promotion.id
      }
      return sale
    }

    async function promotion({ inclusive = true, limit = 5, campaignId }: { inclusive?: boolean; limit?: number; campaignId?: string } = {}) {
      return container.resolve(Modules.PROMOTION).createPromotions({
        code: `coupon-write-${randomUUID()}`, type: 'standard', status: 'active', is_tax_inclusive: inclusive, limit,
        ...(campaignId ? { campaign_id: campaignId } : {}),
        application_method: { type: 'fixed', target_type: 'items', allocation: 'across', value: 1, currency_code: 'eur' },
      })
    }

    async function price(sale: CommandEnvelope<Payload>) {
      const priced = await orderCoupons(container, {}, sale.payload)
      expect(priced.ok).toBe(true)
      if (!priced.ok) throw new Error(JSON.stringify(priced.error))
      return priced.writes
    }

    function result(outcome: ExecuteOutcome) {
      expect(outcome.kind).toBe('result')
      if (outcome.kind !== 'result') throw new Error(`Expected result, received ${JSON.stringify(outcome)}`)
      return outcome.result
    }

    function liveOrders(clientOrderId: string) {
      return container.resolve(ContainerRegistrationKeys.PG_CONNECTION)('order')
        .whereRaw("metadata->>'tally_client_id' = ?", [clientOrderId])
        .whereNull('deleted_at').whereNot('status', 'canceled')
    }

    async function used(promotionId: string) {
      return (await container.resolve(Modules.PROMOTION).retrievePromotion(promotionId)).used
    }

    async function nothingStored(sale: CommandEnvelope<Payload>, promotionId: string, previousUsed = 0) {
      expect(await ledger.listTallyCommands({ id: sale.id }, { withDeleted: true })).toHaveLength(0)
      expect(await liveOrders(sale.payload.clientOrderId)).toHaveLength(0)
      expect(await used(promotionId)).toBe(previousUsed)
    }

    async function applied(sale: CommandEnvelope<Payload>, outcome: ExecuteOutcome) {
      const stored = result(outcome)
      const { data: [order] } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({
        entity: 'order', filters: { id: (stored.serverRefs?.orderId as string | undefined) ?? [] },
        fields: ['id', 'total', 'tax_total', 'discount_subtotal', 'items.adjustments.*'],
      })
      if (stored.status !== 'applied' || stored.serverRefs?.totalMinor !== sale.payload.totalMinor || 'warnings' in stored) {
        throw new Error(JSON.stringify({ result: stored, total: order?.total, tax_total: order?.tax_total, discount_subtotal: order?.discount_subtotal }))
      }
      expect(stored).toMatchObject({ status: 'applied', serverRefs: { totalMinor: sale.payload.totalMinor } })
      expect(stored).not.toHaveProperty('warnings')
      return order
    }

    async function links(filters: { order_id?: string; promotion_id?: string }) {
      return (await container.resolve(ContainerRegistrationKeys.QUERY).graph({ entity: 'order_promotion', filters, fields: ['promotion_id'] })).data
    }

    it('writes a tax-inclusive coupon and counts it once, including a duplicate command', async () => {
      const promo = await promotion(), sale = command(inclusive, promo), writes = await price(sale)
      const order = await applied(sale, await executeOrderCreate(container, sale, {}, writes))
      expect(sale.payload.totalMinor).toBe(1090)
      expect(order.items).toHaveLength(1)
      const adjustments = order.items[0].adjustments!.filter(adjustment => adjustment.promotion_id)
      expect(adjustments).toHaveLength(1)
      expect(adjustments[0]).toMatchObject({ code: promo.code, promotion_id: promo.id, is_tax_inclusive: true })
      expect(Number(adjustments[0].amount)).toBe(1)
      expect(await links({ order_id: order.id })).toEqual([expect.objectContaining({ promotion_id: promo.id })])
      expect(await used(promo.id)).toBe(1)
      expect(result(await executeOrderCreate(container, sale, {}, writes)).status).toBe('duplicate')
      expect(await used(promo.id)).toBe(1)
    })

    it('writes a tax-exclusive coupon alongside the till line discount', async () => {
      const promo = await promotion({ inclusive: false }), sale = command(inclusive, promo)
      Object.assign(sale.payload, { pricesIncludeTax: false, discountMinor: 100, subtotalMinor: 800, taxMinor: 152, totalMinor: 952 })
      Object.assign(sale.payload.lines[0], { unitPriceMinor: 1000, discountMinor: 100 })
      Object.assign(sale.payload.coupons[0], { discountMinor: 100, discountTaxMinor: 19 })
      sale.payload.payments[0].amountMinor = 952
      const writes = await price(sale)
      const order = await applied(sale, await executeOrderCreate(container, sale, {}, writes))
      const adjustments = order.items[0].adjustments!
      expect(adjustments).toHaveLength(2)
      expect(adjustments.find(adjustment => !adjustment.promotion_id)).toMatchObject({ description: 'POS discount' })
      expect(adjustments.filter(adjustment => adjustment.promotion_id)).toEqual([
        expect.objectContaining({ promotion_id: promo.id, is_tax_inclusive: false }),
      ])
    })

    it('reverts adjustments, links and usage after fulfillment fails, then counts the retry once', async () => {
      const promo = await promotion({ limit: 1 }), sale = command(inclusive, promo), writes = await price(sale)
      jest.spyOn(container.resolve(Modules.FULFILLMENT), 'createFulfillment').mockRejectedValueOnce(new Error('coupon-write fulfillment failure'))
      expect(await executeOrderCreate(container, sale, {}, writes)).toMatchObject({ kind: 'transient' })
      await nothingStored(sale, promo.id)
      expect(await links({ promotion_id: promo.id })).toHaveLength(0)
      await applied(sale, await executeOrderCreate(container, sale, {}, writes))
      expect(await used(promo.id)).toBe(1)
    })

    it('rejects stale writes when the promotion limit is exhausted', async () => {
      const promo = await promotion({ limit: 1 }), saleA = command(inclusive, promo), saleB = command(inclusive, promo)
      const writesA = await price(saleA), writesB = await price(saleB)
      await applied(saleA, await executeOrderCreate(container, saleA, {}, writesA))
      expect(await executeOrderCreate(container, saleB, {}, writesB)).toEqual({ kind: 'result', result: {
        id: saleB.id, status: 'rejected', error: { code: 'coupon_invalid', message: 'This coupon has been used up.',
          data: { couponCode: promo.code, storeCode: 'limit_reached' } },
      } })
      await nothingStored(saleB, promo.id, 1)
    })

    it('rejects stale writes when the campaign spend budget is exhausted', async () => {
      const [campaign] = await container.resolve(Modules.PROMOTION).createCampaigns([{
        name: 'Coupon write budget', campaign_identifier: `coupon-write-${randomUUID()}`,
        budget: { type: 'spend', limit: 1.5, currency_code: 'eur' },
      }])
      const promo = await promotion({ campaignId: campaign.id }), saleA = command(inclusive, promo), saleB = command(inclusive, promo)
      const writesA = await price(saleA), writesB = await price(saleB)
      await applied(saleA, await executeOrderCreate(container, saleA, {}, writesA))
      expect(await executeOrderCreate(container, saleB, {}, writesB)).toEqual({ kind: 'result', result: {
        id: saleB.id, status: 'rejected', error: { code: 'coupon_invalid', message: "This coupon's budget has run out.",
          data: { couponCode: promo.code, storeCode: 'budget_exceeded' } },
      } })
      await nothingStored(saleB, promo.id, 1)
    })

    it('resumes a draft created before coupon adjustments and usage', async () => {
      const promo = await promotion(), sale = command(inclusive, promo), writes = await price(sale)
      const planned = planOrderCreate(sale.payload, { customer: null, commandId: sale.id, salesChannelId: data.channelId,
        region: { id: data.regionId, currency_code: 'eur', country_codes: ['de', 'dk'] },
        location: { id: data.berlinId, address: { address_1: 'Alexanderplatz 1', city: 'Berlin', country_code: 'de', postal_code: '10178' } },
        variants: { [data.variantA]: { id: data.variantA } },
      }, sale.version)
      if (!planned.ok) throw new Error('Expected draft plan')
      planned.plan.draftOrder.metadata.tally_coupons = writes
      const { result: draft } = await createOrderWorkflow(container).run({ input: planned.plan.draftOrder as unknown as CreateOrderWorkflowInput })
      const crashed = await container.resolve(Modules.ORDER).retrieveOrder(draft.id, { relations: ['items.adjustments'] })
      expect(crashed.is_draft_order).toBe(true)
      expect(crashed.items!.flatMap(item => item.adjustments ?? [])).toHaveLength(0)
      expect(await used(promo.id)).toBe(0)
      const order = await applied(sale, await executeOrderCreate(container, sale, {}))
      expect(order.id).toBe(draft.id)
      expect(order.items[0].adjustments!.filter(adjustment => adjustment.promotion_id)).toEqual([
        expect.objectContaining({ promotion_id: promo.id }),
      ])
      expect(await used(promo.id)).toBe(1)
    })

    it('refuses to store a coupon order without writes', async () => {
      const promo = await promotion(), sale = command(inclusive, promo)
      expect(await executeOrderCreate(container, sale, {})).toMatchObject({ kind: 'transient', message: expect.stringContaining(promo.code!) })
      await nothingStored(sale, promo.id)
    })
  },
})
