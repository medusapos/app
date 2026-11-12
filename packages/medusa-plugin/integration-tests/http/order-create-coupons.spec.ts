import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { MedusaContainer, PromotionDTO } from '@medusajs/framework/types'
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import { createOrderWorkflow, type CreateOrderWorkflowInput } from '@medusajs/medusa/core-flows'
import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import type { CommandEnvelope, CommandResult, OrderCreatePayload } from '@tallyui/core' with { 'resolution-mode': 'import' }
import { TALLY_LEDGER_MODULE } from '../../src/modules/tally-ledger'
import type TallyLedgerModuleService from '../../src/modules/tally-ledger/service'
import { orderCoupons } from '../../src/workflows/tally-coupons/order-coupons'
import { planOrderCreate } from '../../src/workflows/tally-order-create/plan'
import { couponResumeWorkflow } from '../../src/workflows/tally-order-create/workflow'
import inclusive from '../../src/workflows/tally-order-create/__fixtures__/order-create-coupon-envelopes-2026-11-12/inclusive-coupon.json'
import repro from '../../src/workflows/tally-order-create/__fixtures__/order-create-coupon-envelopes-2026-11-12/inclusive-line-discount-coupon.json'
import { seed } from './seed'

type Payload = OrderCreatePayload & {
  coupons: NonNullable<OrderCreatePayload['coupons']>
  display: NonNullable<OrderCreatePayload['display']>
}

jest.setTimeout(180000)

medusaIntegrationTestRunner({
  cwd: path.resolve(__dirname, '../plugin-app'),
  testSuite: ({ api, getContainer }) => {
    let container: MedusaContainer
    let ledger: TallyLedgerModuleService
    let data: Awaited<ReturnType<typeof seed>>
    let headers: Record<string, string>
    beforeAll(async () => {
      container = getContainer()
      ledger = container.resolve(TALLY_LEDGER_MODULE)
      data = await seed(container)
      const email = 'order-coupons-admin@example.com', password = 'integration-test-password'
      const user = await container.resolve(Modules.USER).createUsers({ email })
      const auth = container.resolve(Modules.AUTH)
      const { authIdentity, error } = await auth.register('emailpass', { body: { email, password } })
      expect(error).toBeUndefined()
      await auth.updateAuthIdentities({ id: authIdentity!.id, app_metadata: { user_id: user.id } })
      const login = await api.post('/auth/user/emailpass', { email, password })
      expect(login.status).toBe(200)
      headers = { Authorization: `Bearer ${login.data.token}`, 'X-Tally-Protocol': '1' }
    })

    function command(fixture: typeof inclusive | typeof repro, promotion?: PromotionDTO) {
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

    async function post(sale: CommandEnvelope<Payload>): Promise<CommandResult> {
      const response = await api.post('/tally/v1/commands', { commands: [sale] }, { headers, validateStatus: () => true })
      expect(response.status).toBe(200)
      expect(response.data.results).toHaveLength(1)
      return response.data.results[0]
    }

    function ordersFor(sale: CommandEnvelope<Payload>) {
      return container.resolve(ContainerRegistrationKeys.PG_CONNECTION)('order')
        .whereRaw("metadata->>'tally_client_id' = ?", [sale.payload.clientOrderId])
    }

    async function nothingStored(sale: CommandEnvelope<Payload>) {
      expect(await ledger.listTallyCommands({ id: sale.id })).toHaveLength(0)
      expect(await ordersFor(sale)).toHaveLength(0)
    }

    it('refuses the 3.19.0 repro (990 vs 971) with not_applicable and stores nothing', async () => {
      const sale = command(repro)
      expect(await post(sale)).toEqual({ id: sale.id, status: 'rejected', error: {
        code: 'coupon_invalid', message: "This coupon can't be combined with a discount on a tax-inclusive item yet.",
        data: { couponCode: 'c', storeCode: 'not_applicable' },
      } })
      await nothingStored(sale)
    })

    it("applies a store-priced coupon at the till's total", async () => {
      const promotion = await container.resolve(Modules.PROMOTION).createPromotions({
        code: 'order-coupon-inclusive', type: 'standard', status: 'active', is_tax_inclusive: true, limit: 5,
        application_method: { type: 'fixed', target_type: 'items', allocation: 'across', value: 1, currency_code: 'eur' },
      })
      const sale = command(inclusive, promotion)
      const result = await post(sale)
      expect(result).toMatchObject({ id: sale.id, status: 'applied', serverRefs: { totalMinor: 1090 } })
      expect(result).not.toHaveProperty('warnings')
      expect((await container.resolve(Modules.PROMOTION).retrievePromotion(promotion.id)).used).toBe(1)
    })

    it('retries a crashed coupon order without re-pricing a used-up coupon', async () => {
      const promotions = container.resolve(Modules.PROMOTION)
      const promotion = await promotions.createPromotions({
        code: 'order-coupon-crashed', type: 'standard', status: 'active', is_tax_inclusive: true, limit: 1,
        application_method: { type: 'fixed', target_type: 'items', allocation: 'across', value: 1, currency_code: 'eur' },
      })
      const sale = command(inclusive, promotion)
      const coupons = await orderCoupons(container, {}, sale.payload)
      if (!coupons.ok) throw new Error('Expected coupon writes')
      const planned = planOrderCreate(sale.payload, { customer: null, commandId: sale.id, salesChannelId: data.channelId,
        region: { id: data.regionId, currency_code: 'eur', country_codes: ['de', 'dk'] },
        location: { id: data.berlinId, address: { address_1: 'Alexanderplatz 1', city: 'Berlin', country_code: 'de', postal_code: '10178' } },
        variants: { [data.variantA]: { id: data.variantA } },
      }, sale.version)
      if (!planned.ok) throw new Error('Expected draft plan')
      planned.plan.draftOrder.metadata.tally_coupons = coupons.writes
      const { result: draft } = await createOrderWorkflow(container).run({ input: planned.plan.draftOrder as unknown as CreateOrderWorkflowInput })
      await couponResumeWorkflow(container).run({ input: { orderId: draft.id } })
      expect((await container.resolve(Modules.ORDER).retrieveOrder(draft.id)).is_draft_order).toBe(true)
      expect((await promotions.retrievePromotion(promotion.id)).used).toBe(1)
      const result = await post(sale)
      expect(result).toMatchObject({ id: sale.id, status: 'applied', serverRefs: { orderId: draft.id, totalMinor: 1090 } })
      expect(result).not.toHaveProperty('warnings')
      expect((await promotions.retrievePromotion(promotion.id)).used).toBe(1)
    })

    it('still refuses display-only coupons with the interim message', async () => {
      const sale = command(inclusive)
      delete (sale.payload as OrderCreatePayload).coupons
      expect(await post(sale)).toEqual({ id: sale.id, status: 'rejected', error: {
        code: 'coupon_invalid', message: 'this store does not apply till coupons yet',
      } })
      await nothingStored(sale)
    })

    it('refuses amount_mismatch when the store prices the coupon at its own rate differently', async () => {
      const promotion = await container.resolve(Modules.PROMOTION).createPromotions({
        code: 'order-coupon-exclusive', type: 'standard', status: 'active', is_tax_inclusive: false,
        application_method: { type: 'fixed', target_type: 'items', allocation: 'across', value: 1, currency_code: 'eur' },
      })
      const sale = command(inclusive, promotion)
      expect(await post(sale)).toEqual({ id: sale.id, status: 'rejected', error: {
        code: 'coupon_invalid', message: "This coupon's amount has changed since it was applied.",
        data: { couponCode: promotion.code, storeCode: 'amount_mismatch' },
      } })
      await nothingStored(sale)
    })

    it("refuses not_found for an unknown code and for a couponId that is not the promotion's", async () => {
      const unknown = command(inclusive)
      unknown.payload.coupons[0].code = 'order-coupon-unknown'
      const promotion = await container.resolve(Modules.PROMOTION).createPromotions({
        code: 'order-coupon-wrong-id', type: 'standard', status: 'active', is_tax_inclusive: true,
        application_method: { type: 'fixed', target_type: 'items', allocation: 'across', value: 1, currency_code: 'eur' },
      })
      const wrongId = command(inclusive, promotion)
      wrongId.payload.coupons[0].couponId = 'promo_other'
      for (const sale of [unknown, wrongId]) {
        expect(await post(sale)).toEqual({ id: sale.id, status: 'rejected', error: {
          code: 'coupon_invalid', message: "This coupon code isn't known to the store.",
          data: { couponCode: sale.payload.coupons[0].code, storeCode: 'not_found' },
        } })
        await nothingStored(sale)
      }
    })

    it('refuses not_active for a draft promotion', async () => {
      const promotion = await container.resolve(Modules.PROMOTION).createPromotions({
        code: 'order-coupon-draft', type: 'standard', status: 'draft', is_tax_inclusive: true,
        application_method: { type: 'fixed', target_type: 'items', allocation: 'across', value: 1, currency_code: 'eur' },
      })
      const sale = command(inclusive, promotion)
      expect(await post(sale)).toEqual({ id: sale.id, status: 'rejected', error: {
        code: 'coupon_invalid', message: "This coupon isn't active right now.",
        data: { couponCode: promotion.code, storeCode: 'not_active' },
      } })
      await nothingStored(sale)
    })

    it("nets the till's line discount on an exclusive sale before pricing", async () => {
      const promotion = await container.resolve(Modules.PROMOTION).createPromotions({
        code: 'order-coupon-discounted', type: 'standard', status: 'active', is_tax_inclusive: false,
        application_method: { type: 'percentage', target_type: 'items', allocation: 'across', value: 10 },
      })
      for (const [discountMinor, discountTaxMinor] of [[90, 17], [100, 19]]) {
        const sale = command(inclusive, promotion)
        sale.payload.pricesIncludeTax = false
        Object.assign(sale.payload.lines[0], { unitPriceMinor: 1000, discountMinor: 100 })
        sale.payload.discountMinor = 100
        Object.assign(sale.payload.coupons[0], { discountMinor, discountTaxMinor })
        if (discountMinor === 90) {
          expect(await post(sale)).toMatchObject({ id: sale.id, status: 'applied' })
        } else {
          expect(await post(sale)).toEqual({ id: sale.id, status: 'rejected', error: {
            code: 'coupon_invalid', message: "This coupon's amount has changed since it was applied.",
            data: { couponCode: promotion.code, storeCode: 'amount_mismatch' },
          } })
          await nothingStored(sale)
        }
      }
    })
  },
})
