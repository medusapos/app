import path from 'node:path'
import type { IPromotionModuleService, MedusaContainer } from '@medusajs/framework/types'
import { Modules } from '@medusajs/framework/utils'
import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import type { CouponSale } from '../../src/workflows/tally-coupons/coupon-context'
import { seed } from './seed'

jest.setTimeout(180000)

medusaIntegrationTestRunner({
  cwd: path.resolve(__dirname, '../plugin-app'),
  testSuite: ({ api, getContainer }) => {
    let container: MedusaContainer
    let promotions: IPromotionModuleService
    let data: Awaited<ReturnType<typeof seed>>
    let headers: Record<string, string>
    let sale: CouponSale
    beforeAll(async () => {
      container = getContainer()
      promotions = container.resolve(Modules.PROMOTION)
      data = await seed(container)
      const email = 'preview-admin@example.com'
      const password = 'integration-test-password'
      const user = await container.resolve(Modules.USER).createUsers({ email })
      const auth = container.resolve(Modules.AUTH)
      const { authIdentity, error } = await auth.register('emailpass', { body: { email, password } })
      expect(error).toBeUndefined()
      await auth.updateAuthIdentities({ id: authIdentity!.id, app_metadata: { user_id: user.id } })
      const login = await api.post('/auth/user/emailpass', { email, password })
      expect(login.status).toBe(200)
      headers = { Authorization: `Bearer ${login.data.token}`, 'X-Tally-Protocol': '1' }
    })
    beforeEach(() => {
      sale = { currency: 'EUR', locationId: data.berlinId, lines: [{
        lineId: 'line-a', variantId: data.variantA, quantity: 1,
        taxInclusive: false, netMinor: 1000, taxRatePpm: 190000,
      }] }
    })

    function preview(body: unknown) {
      return api.post('/tally/v1/promotions/preview', body, { headers, validateStatus: () => true })
    }

    it("prices a code per line and replies with exactly the ADR's keys", async () => {
      const code = 'route-fixed'
      const promotion = await promotions.createPromotions({
        code, type: 'standard', status: 'active', is_tax_inclusive: false,
        application_method: { type: 'fixed', target_type: 'items', allocation: 'across', value: 1, currency_code: 'eur' },
      })
      const response = await preview({ ...sale, codes: [` ${code} `] })
      expect(response.status).toBe(200)
      expect(response.data).toEqual({ coupons: [{
        code, couponId: promotion.id, lines: [{ lineId: 'line-a', amountMinor: 100 }],
      }] })
    })

    it('replies in request order with a refusal beside a priced code', async () => {
      const code = 'route-ordered'
      const promotion = await promotions.createPromotions({
        code, type: 'standard', status: 'active', is_tax_inclusive: false,
        application_method: { type: 'fixed', target_type: 'items', allocation: 'across', value: 1, currency_code: 'eur' },
      })
      const response = await preview({ ...sale, codes: ['route-unknown', code] })
      expect(response.status).toBe(200)
      expect(response.data).toEqual({ coupons: [
        { code: 'route-unknown', storeCode: 'not_found', message: "This coupon code isn't known to the store." },
        { code, couponId: promotion.id, lines: [{ lineId: 'line-a', amountMinor: 100 }] },
      ] })
    })

    it("prices against the request's customer", async () => {
      const customers = container.resolve(Modules.CUSTOMER)
      const customer = await customers.createCustomers({ email: 'preview-customer@example.com' })
      const group = await customers.createCustomerGroups({ name: 'Preview customer group' })
      await customers.addCustomerToGroup({ customer_id: customer.id, customer_group_id: group.id })
      const code = 'route-customer'
      const promotion = await promotions.createPromotions({
        code, type: 'standard', status: 'active', is_tax_inclusive: false,
        rules: [{ attribute: 'customer.groups.id', operator: 'in', values: [group.id] }],
        application_method: { type: 'fixed', target_type: 'items', allocation: 'across', value: 1, currency_code: 'eur' },
      })
      const response = await preview({ ...sale, customerId: customer.id, codes: [code] })
      expect(response.status).toBe(200)
      expect(response.data).toEqual({ coupons: [{
        code, couponId: promotion.id, lines: [{ lineId: 'line-a', amountMinor: 100 }],
      }] })
      const withoutCustomer = await preview({ ...sale, customerId: null, codes: [code] })
      expect(withoutCustomer.status).toBe(200)
      expect(withoutCustomer.data).toEqual({ coupons: [{
        code, storeCode: 'not_applicable', message: "This coupon doesn't apply to this sale.",
      }] })
    })

    it('does not register usage', async () => {
      const code = 'route-usage'
      const promotion = await promotions.createPromotions({
        code, type: 'standard', status: 'active', is_tax_inclusive: false, limit: 1,
        application_method: { type: 'fixed', target_type: 'items', allocation: 'across', value: 1, currency_code: 'eur' },
      })
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await preview({ ...sale, codes: [code] })
        expect(response.status).toBe(200)
        expect(response.data).toEqual({ coupons: [{
          code, couponId: promotion.id, lines: [{ lineId: 'line-a', amountMinor: 100 }],
        }] })
      }
      expect(Number((await promotions.retrievePromotion(promotion.id)).used)).toBe(0)
    })

    it('refuses malformed bodies with invalid_payload', async () => {
      const body = { ...sale, codes: ['route-malformed'] }
      const line = sale.lines[0]
      const cases: Array<[unknown, string]> = [
        [sale, 'codes'],
        [{ ...body, codes: [] }, 'codes'],
        [{ ...body, codes: Array(11).fill('route-malformed') }, 'codes'],
        [{ ...body, codes: ['  '] }, 'codes[0]'],
        [{ ...body, currency: 'EURO' }, 'currency'],
        [{ ...body, lines: [] }, 'lines'],
        [{ ...body, lines: [{ ...line, netMinor: -1 }] }, 'lines[0].netMinor'],
        [{ ...body, lines: [{ ...line, netMinor: 1.5 }] }, 'lines[0].netMinor'],
        [{ ...body, lines: [{ ...line, quantity: 0 }] }, 'lines[0].quantity'],
        [{ ...body, lines: [{ ...line, taxInclusive: 'yes' }] }, 'lines[0].taxInclusive'],
        [{ ...body, lines: [{ ...line, taxRatePpm: 1000001 }] }, 'lines[0].taxRatePpm'],
        [{ ...body, lines: [line, line] }, 'lines[1].lineId'],
        [[], 'codes'],
      ]
      for (const [invalid, field] of cases) {
        const response = await preview(invalid)
        expect(response.status).toBe(400)
        expect(response.data.code).toBe('invalid_payload')
        expect(response.data.message).toContain(field)
      }
    })

    it('answers 401 without a token', async () => {
      const response = await api.post('/tally/v1/promotions/preview', { ...sale, codes: ['route-no-token'] }, {
        headers: { 'X-Tally-Protocol': '1' }, validateStatus: () => true,
      })
      expect(response.status).toBe(401)
    })
  },
})
