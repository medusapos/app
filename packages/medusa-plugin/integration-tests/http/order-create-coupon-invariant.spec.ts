import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { MedusaContainer, PromotionDTO } from '@medusajs/framework/types'
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import type { CommandEnvelope, CommandResult, OrderCreatePayload } from '@tallyui/core' with { 'resolution-mode': 'import' }
import { TALLY_LEDGER_MODULE } from '../../src/modules/tally-ledger'
import type TallyLedgerModuleService from '../../src/modules/tally-ledger/service'
import { currencyDecimals, majorToMinor } from '../../src/workflows/tally-order-create/money'
import inclusivePlain from '../../src/workflows/tally-order-create/__fixtures__/order-create-coupon-envelopes-2026-11-12/inclusive-plain.json'
import inclusiveDiscount from '../../src/workflows/tally-order-create/__fixtures__/order-create-coupon-envelopes-2026-11-12/inclusive-line-discount.json'
import inclusiveCoupon from '../../src/workflows/tally-order-create/__fixtures__/order-create-coupon-envelopes-2026-11-12/inclusive-coupon.json'
import inclusiveDiscountCoupon from '../../src/workflows/tally-order-create/__fixtures__/order-create-coupon-envelopes-2026-11-12/inclusive-line-discount-coupon.json'
import exclusivePlain from '../../src/workflows/tally-order-create/__fixtures__/order-create-coupon-envelopes-2026-11-12/exclusive-plain.json'
import exclusiveDiscount from '../../src/workflows/tally-order-create/__fixtures__/order-create-coupon-envelopes-2026-11-12/exclusive-line-discount.json'
import exclusiveCoupon from '../../src/workflows/tally-order-create/__fixtures__/order-create-coupon-envelopes-2026-11-12/exclusive-coupon.json'
import exclusiveDiscountCoupon from '../../src/workflows/tally-order-create/__fixtures__/order-create-coupon-envelopes-2026-11-12/exclusive-line-discount-coupon.json'
import { seed } from './seed'

type Payload = OrderCreatePayload & { display: NonNullable<OrderCreatePayload['display']> }

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
      const email = 'order-coupon-invariant-admin@example.com', password = 'integration-test-password'
      const user = await container.resolve(Modules.USER).createUsers({ email })
      const auth = container.resolve(Modules.AUTH)
      const { authIdentity, error } = await auth.register('emailpass', { body: { email, password } })
      expect(error).toBeUndefined()
      await auth.updateAuthIdentities({ id: authIdentity!.id, app_metadata: { user_id: user.id } })
      const login = await api.post('/auth/user/emailpass', { email, password })
      expect(login.status).toBe(200)
      headers = { Authorization: `Bearer ${login.data.token}`, 'X-Tally-Protocol': '1' }
    })

    function command(fixture: object, promotion?: PromotionDTO) {
      const sale = structuredClone(fixture) as unknown as CommandEnvelope<Payload>
      const payload = sale.payload
      sale.id = randomUUID()
      sale.createdAt = payload.createdAt = new Date().toISOString()
      payload.clientOrderId = randomUUID()
      payload.payments[0].clientPaymentId = randomUUID()
      payload.lines[0].clientLineId = payload.display.lines[0].clientLineId = randomUUID()
      payload.lines[0].variantId = data.variantA
      if (promotion) {
        payload.coupons![0].code = payload.display.coupons![0].code = promotion.code!
        payload.coupons![0].couponId = promotion.id
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

    for (const [name, fixture] of [
      ['inclusive-plain.json', inclusivePlain],
      ['inclusive-line-discount.json', inclusiveDiscount],
      ['inclusive-coupon.json', inclusiveCoupon],
      ['exclusive-plain.json', exclusivePlain],
      ['exclusive-line-discount.json', exclusiveDiscount],
      ['exclusive-coupon.json', exclusiveCoupon],
      ['exclusive-line-discount-coupon.json', exclusiveDiscountCoupon],
    ] as const) {
      it(`stores the till's charged total for ${name}`, async () => {
        const promotion = 'coupons' in fixture.payload ? await container.resolve(Modules.PROMOTION).createPromotions({
          code: `coupon-invariant-${randomUUID()}`, type: 'standard', status: 'active', is_tax_inclusive: fixture.payload.pricesIncludeTax, limit: 5,
          application_method: { type: 'fixed', target_type: 'items', allocation: 'across', value: 1, currency_code: 'eur' },
        }) : undefined
        const sale = command(fixture, promotion)
        const result = await post(sale)
        const { data: [order] } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({
          entity: 'order', fields: ['id', 'total', 'tax_total', 'discount_subtotal', 'subtotal'],
          filters: { id: (await ordersFor(sale)).map(order => order.id) },
        })
        try {
          expect(result).toMatchObject({ id: sale.id, status: 'applied', serverRefs: { totalMinor: sale.payload.totalMinor } })
          expect(result).not.toHaveProperty('warnings')
          const charged = sale.payload.payments.reduce((sum, payment) => sum + payment.amountMinor, 0)
          expect(sale.payload.totalMinor).toBe(charged)
          expect(majorToMinor(order.total, currencyDecimals(sale.payload.currency))).toBe(charged)
          if (promotion) expect((await container.resolve(Modules.PROMOTION).retrievePromotion(promotion.id)).used).toBe(1)
        } catch (error) {
          console.error(name, { result, order })
          throw error
        }
      })
    }

    it('refuses inclusive-line-discount-coupon.json until the guard flips at order.create v9', async () => {
      const promotion = await container.resolve(Modules.PROMOTION).createPromotions({
        code: `coupon-invariant-guard-${randomUUID()}`, type: 'standard', status: 'active', is_tax_inclusive: true,
        application_method: { type: 'fixed', target_type: 'items', allocation: 'across', value: 1, currency_code: 'eur' },
      })
      const sale = command(inclusiveDiscountCoupon, promotion)
      expect(await post(sale)).toEqual({ id: sale.id, status: 'rejected', error: {
        code: 'coupon_invalid', message: "This coupon can't be combined with a discount on a tax-inclusive item yet.",
        data: { couponCode: promotion.code, storeCode: 'not_applicable' },
      } })
      await nothingStored(sale)
    })
  },
})
