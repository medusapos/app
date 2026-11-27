import path from 'node:path'
import type { CreatePromotionDTO, IPromotionModuleService, MedusaContainer } from '@medusajs/framework/types'
import { Modules } from '@medusajs/framework/utils'
import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import { COUPON_LIST_LIMIT } from '../../src/api/tally/v1/promotions/coupon-list'
import { seed } from './seed'

jest.setTimeout(180000)

medusaIntegrationTestRunner({
  cwd: path.resolve(__dirname, '../plugin-app'),
  testSuite: ({ api, getContainer }) => {
    const url = '/tally/v1/promotions'
    let container: MedusaContainer
    let promotions: IPromotionModuleService
    let data: Awaited<ReturnType<typeof seed>>
    let headers: Record<string, string>
    beforeAll(async () => {
      container = getContainer()
      promotions = container.resolve(Modules.PROMOTION)
      data = await seed(container)
      const email = 'coupon-list-admin@example.com'
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

    function fixed(code: string): CreatePromotionDTO {
      return { code, type: 'standard', status: 'active', application_method: {
        type: 'fixed', target_type: 'items', allocation: 'across', value: 1, currency_code: 'eur',
      } }
    }

    it('lists only the usable code and only its six public fields', async () => {
      const [ended] = await promotions.createCampaigns([{ name: 'Ended', campaign_identifier: 'ended',
        starts_at: new Date('2020-01-01'), ends_at: new Date('2020-01-02') }])
      const other = await container.resolve(Modules.SALES_CHANNEL).createSalesChannels({ name: 'Other channel' })
      const variant = await container.resolve(Modules.PRODUCT).retrieveProductVariant(data.variantA)
      const buyRule = { attribute: 'items.product.id', operator: 'in' as const, values: [variant.product_id!] }
      await promotions.createPromotions([
        { ...fixed('usable'), rules: [{ attribute: 'sales_channel_id', operator: 'in', values: [data.channelId] }] },
        { ...fixed('automatic'), is_automatic: true }, { ...fixed('inactive'), status: 'inactive' },
        { ...fixed('buyget'), type: 'buyget', application_method: { type: 'percentage', target_type: 'items', allocation: 'each',
          value: 100, max_quantity: 1, buy_rules_min_quantity: 1, apply_to_quantity: 1, buy_rules: [buyRule], target_rules: [buyRule] } },
        { ...fixed('ended'), campaign_id: ended.id },
        { ...fixed('other'), rules: [{ attribute: 'sales_channel_id', operator: 'in', values: [other.id] }] },
      ])
      const response = await api.get(`${url}?currency=eUr`, { headers })
      expect(response.status).toBe(200)
      expect(response.data).toEqual({ coupons: [
        { code: 'usable', label: null, type: 'fixed', value: 100, currency: 'eur', endsAt: null },
      ], limit: 100, truncated: false })
    })

    it('lists a percentage promotion with its stored value', async () => {
      const code = 'ten-percent'
      await promotions.createPromotions({ code, type: 'standard', status: 'active',
        application_method: { type: 'percentage', target_type: 'items', allocation: 'across', value: 10 } })
      const response = await api.get(url, { headers })
      expect(response.data.coupons).toStrictEqual([{ code, label: null, type: 'percentage', value: 10, currency: null, endsAt: null }])
    })

    it('rejects an anonymous request and a signed-in customer with 401', async () => {
      expect((await api.get(url, { validateStatus: () => true })).status).toBe(401)
      const body = { email: 'coupon-customer@example.com', password: 'integration-test-password' }
      expect((await api.post('/auth/customer/emailpass/register', body)).status).toBe(200)
      const customer = await container.resolve(Modules.CUSTOMER).createCustomers({ email: body.email })
      const auth = container.resolve(Modules.AUTH)
      const { authIdentity } = await auth.authenticate('emailpass', { body })
      await auth.updateAuthIdentities({ id: authIdentity!.id, app_metadata: { customer_id: customer.id } })
      const login = await api.post('/auth/customer/emailpass', body)
      expect(login.data.token).toEqual(expect.any(String))
      const response = await api.get(url, { headers: { Authorization: `Bearer ${login.data.token}` }, validateStatus: () => true })
      expect(response.status).toBe(401)
    })

    it.each(['currency=EU', 'currency=eur&currency=eur'])('rejects %s', async query => {
      const response = await api.get(`${url}?${query}`, { headers, validateStatus: () => true })
      expect(response.status).toBe(400)
      expect(response.data).toEqual({ code: 'invalid_currency' })
    })

    it('still previews a typed code beyond the list cap', async () => {
      const codes = Array.from({ length: COUPON_LIST_LIMIT + 1 }, (_, index) => `coupon-${String(index).padStart(3, '0')}`)
      const created = await promotions.createPromotions(codes.map(fixed).reverse())
      const code = codes[COUPON_LIST_LIMIT]
      const response = await api.get(url, { headers })
      expect(response.data.truncated).toBe(true)
      expect(response.data.coupons.map(row => row.code)).toEqual(codes.slice(0, COUPON_LIST_LIMIT))
      const preview = await api.post(`${url}/preview`, { currency: 'EUR', codes: [code], locationId: data.berlinId,
        lines: [{ lineId: 'line-a', variantId: data.variantA, quantity: 1, taxInclusive: false, netMinor: 1000, taxRatePpm: 190000 }],
      }, { headers })
      expect(preview.data).toEqual({ coupons: [{ code, couponId: created.find(row => row.code === code)!.id,
        lines: [{ lineId: 'line-a', amountMinor: 100 }] }] })
    })

    it('answers list and preview preflights independently', async () => {
      for (const [endpoint, method] of [[url, 'GET'], [`${url}/preview`, 'POST']]) {
        const response = await api.options(endpoint, { headers: { Origin: 'http://localhost',
          'Access-Control-Request-Method': method, 'Access-Control-Request-Headers': 'authorization' } })
        expect(response.status).toBe(204)
        expect(response.headers['access-control-allow-methods']).toBe(`${method},OPTIONS`)
      }
    })

    it('omits an exhausted usage budget but lists a spend budget with room left', async () => {
      for (const type of ['usage', 'spend'] as const) {
        const [campaign] = await promotions.createCampaigns([{ name: type, campaign_identifier: type,
          budget: type === 'usage' ? { type, limit: 1 } : { type, limit: 2, currency_code: 'eur' } }])
        await promotions.createPromotions({ ...fixed(type), campaign_id: campaign.id })
        await promotions.registerUsage([{ code: type, amount: 1 }], { customer_id: null, customer_email: null })
      }
      const response = await api.get(url, { headers })
      expect(response.data.coupons).toEqual([{ code: 'spend', label: 'spend', type: 'fixed', value: 100, currency: 'eur', endsAt: null }])
    })
  },
})
