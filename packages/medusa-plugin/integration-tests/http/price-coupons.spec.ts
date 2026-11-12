import path from 'node:path'
import type { IPromotionModuleService, MedusaContainer } from '@medusajs/framework/types'
import { Modules } from '@medusajs/framework/utils'
import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import { buildCouponContext, type CouponSale } from '../../src/workflows/tally-coupons/coupon-context'
import { priceCoupons } from '../../src/workflows/tally-coupons/price-coupons'
import { seed } from './seed'

jest.setTimeout(180000)

medusaIntegrationTestRunner({
  cwd: path.resolve(__dirname, '../plugin-app'),
  testSuite: ({ getContainer }) => {
    let container: MedusaContainer
    let promotions: IPromotionModuleService
    let data: Awaited<ReturnType<typeof seed>>
    let sale: CouponSale
    beforeAll(async () => {
      container = getContainer()
      promotions = container.resolve(Modules.PROMOTION)
      data = await seed(container)
    })
    beforeEach(() => {
      sale = { currency: 'EUR', lines: [{
        lineId: 'line-a', variantId: data.variantA, quantity: 1,
        taxInclusive: false, netMinor: 1000, taxRatePpm: 190000,
      }] }
    })

    it('prices a fixed coupon on an exclusive line and matches the stored code case-insensitively', async () => {
      const promotion = await promotions.createPromotions({
        code: 'COUPON-FIXED', type: 'standard', status: 'active', is_tax_inclusive: false,
        application_method: { type: 'fixed', target_type: 'items', allocation: 'across', value: 1, currency_code: 'eur' },
      })
      const context = await buildCouponContext(container, {}, sale)
      const actions = await promotions.computeActions(['COUPON-FIXED'], context.compute, { prevent_auto_promotions: true })
      const result = await priceCoupons(container, context, ['coupon-fixed'])
      expect(result).toEqual([{
        code: 'coupon-fixed', ok: true, couponId: promotion.id, promotionCode: 'COUPON-FIXED',
        lines: [{ lineId: 'line-a', amountMinor: 100 }], actions,
      }])
      expect(actions).toEqual([expect.objectContaining({
        action: 'addItemAdjustment', item_id: 'line-a', code: 'COUPON-FIXED', is_tax_inclusive: false,
      })])
      expect(Number((await promotions.retrievePromotion(promotion.id)).used)).toBe(0)
    })

    it('splits a percentage coupon across two exclusive lines', async () => {
      await promotions.createPromotions({
        code: 'coupon-split', type: 'standard', status: 'active', is_tax_inclusive: false,
        application_method: { type: 'percentage', target_type: 'items', allocation: 'across', value: 10 },
      })
      sale.lines.push({ ...sale.lines[0], lineId: 'line-b', variantId: data.variantB, netMinor: 500 })
      const context = await buildCouponContext(container, {}, sale)
      expect(await priceCoupons(container, context, ['coupon-split'])).toMatchObject([{
        code: 'coupon-split', ok: true,
        lines: [{ lineId: 'line-a', amountMinor: 100 }, { lineId: 'line-b', amountMinor: 50 }],
      }])
    })

    it("prices a tax-exclusive promotion on a tax-inclusive line in the line's own mode", async () => {
      await promotions.createPromotions({
        code: 'coupon-net-to-gross', type: 'standard', status: 'active', is_tax_inclusive: false,
        application_method: { type: 'percentage', target_type: 'items', allocation: 'across', value: 10 },
      })
      sale.lines[0].taxInclusive = true
      sale.lines[0].netMinor = 1190
      const context = await buildCouponContext(container, {}, sale)
      expect(await priceCoupons(container, context, ['coupon-net-to-gross'])).toMatchObject([{
        code: 'coupon-net-to-gross', ok: true, lines: [{ lineId: 'line-a', amountMinor: 119 }],
        actions: [{ action: 'addItemAdjustment', item_id: 'line-a', is_tax_inclusive: false }],
      }])
    })

    it("takes the store's rate at the location when the line gives none", async () => {
      await promotions.createPromotions({
        code: 'coupon-store-rate', type: 'standard', status: 'active', is_tax_inclusive: false,
        application_method: { type: 'fixed', target_type: 'items', allocation: 'across', value: 1, currency_code: 'eur' },
      })
      sale.locationId = data.berlinId
      sale.lines[0].taxInclusive = true
      sale.lines[0].netMinor = 1190
      delete sale.lines[0].taxRatePpm
      const context = await buildCouponContext(container, {}, sale)
      expect(await priceCoupons(container, context, ['coupon-store-rate'])).toMatchObject([{
        code: 'coupon-store-rate', ok: true, lines: [{ lineId: 'line-a', amountMinor: 119 }],
      }])
      expect(context.lines[0].taxRatePpm).toBe(190000)
    })

    it('takes the Danish rate for a stock location in Denmark', async () => {
      const location = await container.resolve(Modules.STOCK_LOCATION).createStockLocations({
        name: 'Copenhagen',
        address: { address_1: 'Strøget 1', city: 'København', country_code: 'dk', postal_code: '1160' },
      })
      await promotions.createPromotions({
        code: 'coupon-danish-rate', type: 'standard', status: 'active', is_tax_inclusive: false,
        application_method: { type: 'fixed', target_type: 'items', allocation: 'across', value: 1, currency_code: 'eur' },
      })
      sale.locationId = location.id
      sale.lines[0].taxInclusive = true
      sale.lines[0].netMinor = 1250
      delete sale.lines[0].taxRatePpm
      const context = await buildCouponContext(container, {}, sale)
      expect(await priceCoupons(container, context, ['coupon-danish-rate'])).toMatchObject([{
        code: 'coupon-danish-rate', ok: true, lines: [{ lineId: 'line-a', amountMinor: 125 }],
      }])
      expect(context.lines[0].taxRatePpm).toBe(250000)
    })

    it("keeps a rate the line gives over the store's", async () => {
      await promotions.createPromotions({
        code: 'coupon-given-rate', type: 'standard', status: 'active', is_tax_inclusive: false,
        application_method: { type: 'percentage', target_type: 'items', allocation: 'across', value: 10 },
      })
      sale.locationId = data.berlinId
      sale.lines[0].taxInclusive = true
      sale.lines[0].netMinor = 1250
      sale.lines[0].taxRatePpm = 250000
      const context = await buildCouponContext(container, {}, sale)
      expect(await priceCoupons(container, context, ['coupon-given-rate'])).toMatchObject([{
        code: 'coupon-given-rate', ok: true, lines: [{ lineId: 'line-a', amountMinor: 125 }],
      }])
      expect(context.lines[0].taxRatePpm).toBe(250000)
    })

    it("gives a custom line the location's default rate", async () => {
      sale.locationId = data.berlinId
      sale.lines[0].taxInclusive = true
      sale.lines[0].netMinor = 1190
      delete sale.lines[0].variantId
      delete sale.lines[0].taxRatePpm
      const context = await buildCouponContext(container, {}, sale)
      expect(context.lines[0].taxRatePpm).toBe(190000)
    })

    it("prices a tax-inclusive promotion on a tax-exclusive line in the line's own mode", async () => {
      await promotions.createPromotions({
        code: 'coupon-gross-to-net', type: 'standard', status: 'active', is_tax_inclusive: true,
        application_method: { type: 'fixed', target_type: 'items', allocation: 'across', value: 1.19, currency_code: 'eur' },
      })
      const context = await buildCouponContext(container, {}, sale)
      expect(await priceCoupons(container, context, ['coupon-gross-to-net'])).toMatchObject([{
        code: 'coupon-gross-to-net', ok: true, lines: [{ lineId: 'line-a', amountMinor: 100 }],
        actions: [{ action: 'addItemAdjustment', item_id: 'line-a', is_tax_inclusive: true }],
      }])
    })

    it('refuses an unknown code with not_found', async () => {
      const context = await buildCouponContext(container, {}, sale)
      expect(await priceCoupons(container, context, ['coupon-unknown'])).toEqual([{
        code: 'coupon-unknown', ok: false, storeCode: 'not_found', message: "This coupon code isn't known to the store.",
      }])
    })

    it('refuses a draft promotion and an ended campaign with not_active', async () => {
      await promotions.createPromotions({
        code: 'coupon-draft', type: 'standard', status: 'draft',
        application_method: { type: 'fixed', target_type: 'items', allocation: 'across', value: 1, currency_code: 'eur' },
      })
      const [campaign] = await promotions.createCampaigns([{
        name: 'Ended coupon campaign', campaign_identifier: 'coupon-ended-campaign',
        starts_at: new Date(Date.now() - 172800000), ends_at: new Date(Date.now() - 86400000),
      }])
      await promotions.createPromotions({
        code: 'coupon-ended', type: 'standard', status: 'active', campaign_id: campaign.id,
        application_method: { type: 'fixed', target_type: 'items', allocation: 'across', value: 1, currency_code: 'eur' },
      })
      const context = await buildCouponContext(container, {}, sale)
      expect(await priceCoupons(container, context, ['coupon-draft', 'coupon-ended'])).toEqual([
        { code: 'coupon-draft', ok: false, storeCode: 'not_active', message: "This coupon isn't active right now." },
        { code: 'coupon-ended', ok: false, storeCode: 'not_active', message: "This coupon isn't active right now." },
      ])
    })

    it('refuses buyget, order and shipping-method promotions with the till-yet message', async () => {
      const variant = await container.resolve(Modules.PRODUCT).retrieveProductVariant(data.variantA)
      await promotions.createPromotions({
        code: 'coupon-buyget', type: 'buyget', status: 'active',
        application_method: { type: 'percentage', target_type: 'items', allocation: 'each', value: 100,
          max_quantity: 1, buy_rules_min_quantity: 1, apply_to_quantity: 1,
          buy_rules: [{ attribute: 'items.product.id', operator: 'in', values: [variant.product_id!] }],
          target_rules: [{ attribute: 'items.product.id', operator: 'in', values: [variant.product_id!] }],
        },
      })
      for (const target_type of ['order', 'shipping_methods'] as const) {
        await promotions.createPromotions({
          code: `coupon-${target_type}`, type: 'standard', status: 'active',
          application_method: { type: 'fixed', target_type, allocation: 'across', value: 1, currency_code: 'eur' },
        })
      }
      const context = await buildCouponContext(container, {}, sale)
      const codes = ['coupon-buyget', 'coupon-order', 'coupon-shipping_methods']
      expect(await priceCoupons(container, context, codes)).toEqual(codes.map(code => ({
        code, ok: false, storeCode: 'not_applicable', message: "This coupon can't be used at the till yet",
      })))
    })

    it('refuses a promotion whose rules do not match with not_applicable', async () => {
      const group = await container.resolve(Modules.CUSTOMER).createCustomerGroups({ name: 'Coupon excluded group' })
      await promotions.createPromotions({
        code: 'coupon-wrong-group', type: 'standard', status: 'active',
        rules: [{ attribute: 'customer.groups.id', operator: 'in', values: [group.id] }],
        application_method: { type: 'fixed', target_type: 'items', allocation: 'across', value: 1, currency_code: 'eur' },
      })
      await promotions.createPromotions({
        code: 'coupon-wrong-currency', type: 'standard', status: 'active',
        application_method: { type: 'fixed', target_type: 'items', allocation: 'across', value: 1, currency_code: 'usd' },
      })
      const context = await buildCouponContext(container, {}, sale)
      const codes = ['coupon-wrong-group', 'coupon-wrong-currency']
      expect(await priceCoupons(container, context, codes)).toEqual(codes.map(code => ({
        code, ok: false, storeCode: 'not_applicable', message: "This coupon doesn't apply to this sale.",
      })))
    })

    it('refuses a used-up limit with limit_reached', async () => {
      const promotion = await promotions.createPromotions({
        code: 'coupon-limit', type: 'standard', status: 'active', limit: 1,
        application_method: { type: 'fixed', target_type: 'items', allocation: 'across', value: 1, currency_code: 'eur' },
      })
      await promotions.registerUsage([{ code: 'coupon-limit', amount: 1 }], { customer_id: null, customer_email: null })
      const context = await buildCouponContext(container, {}, sale)
      expect(await priceCoupons(container, context, ['coupon-limit'])).toEqual([{
        code: 'coupon-limit', ok: false, storeCode: 'limit_reached', message: 'This coupon has been used up.',
      }])
      expect(Number((await promotions.retrievePromotion(promotion.id)).used)).toBe(1)
    })

    it('refuses an exceeded spend budget with budget_exceeded', async () => {
      const [campaign] = await promotions.createCampaigns([{
        name: 'Coupon spend budget', campaign_identifier: 'coupon-budget-campaign',
        budget: { type: 'spend', limit: 0.5, currency_code: 'eur' },
      }])
      await promotions.createPromotions({
        code: 'coupon-budget', type: 'standard', status: 'active', campaign_id: campaign.id,
        application_method: { type: 'fixed', target_type: 'items', allocation: 'across', value: 1, currency_code: 'eur' },
      })
      const context = await buildCouponContext(container, {}, sale)
      expect(await priceCoupons(container, context, ['coupon-budget'])).toEqual([{
        code: 'coupon-budget', ok: false, storeCode: 'budget_exceeded', message: "This coupon's budget has run out.",
      }])
      const after = await promotions.retrieveCampaign(campaign.id, { relations: ['budget'] })
      expect(Number(after.budget!.used)).toBe(0)
    })

    it("buildCouponContext resolves the seed's region, channel and country, the customer's groups, and the product", async () => {
      const customers = container.resolve(Modules.CUSTOMER)
      const customer = await customers.createCustomers({ email: 'coupon-context@example.com' })
      const group = await customers.createCustomerGroups({ name: 'Coupon context group' })
      await customers.addCustomerToGroup({ customer_id: customer.id, customer_group_id: group.id })
      sale.customerId = customer.id
      sale.lines[0].taxInclusive = true
      sale.lines[0].netMinor = 1190
      const context = await buildCouponContext(container, {}, sale)
      expect(context).toMatchObject({ currency: 'eur', decimals: 2, lines: sale.lines, compute: {
        currency_code: 'eur', region: { id: data.regionId }, sales_channel_id: data.channelId,
        shipping_address: { country_code: 'de' }, email: customer.email,
        customer: { id: customer.id, groups: expect.arrayContaining([{ id: group.id }]) },
      } })
      const variant = await container.resolve(Modules.PRODUCT).retrieveProductVariant(data.variantA, { relations: ['product'] })
      const item = context.compute.items![0]
      expect(item).toMatchObject({
        id: 'line-a', quantity: 1, is_discountable: true, product: { id: variant.product!.id }, adjustments: [],
      })
      expect(Number(item.subtotal)).toBe(10)
      expect(Number(item.original_total)).toBe(11.9)
    })

    it("prices against the customer's group when the rule matches", async () => {
      const customers = container.resolve(Modules.CUSTOMER)
      const customer = await customers.createCustomers({ email: 'coupon-group-match@example.com' })
      const group = await customers.createCustomerGroups({ name: 'Coupon matching group' })
      await customers.addCustomerToGroup({ customer_id: customer.id, customer_group_id: group.id })
      sale.customerId = customer.id
      const promotion = await promotions.createPromotions({
        code: 'coupon-matching-group', type: 'standard', status: 'active', is_tax_inclusive: false,
        rules: [{ attribute: 'customer.groups.id', operator: 'in', values: [group.id] }],
        application_method: { type: 'fixed', target_type: 'items', allocation: 'across', value: 1, currency_code: 'eur' },
      })
      const context = await buildCouponContext(container, {}, sale)
      expect(await priceCoupons(container, context, ['coupon-matching-group'])).toMatchObject([{
        code: 'coupon-matching-group', ok: true, couponId: promotion.id, promotionCode: 'coupon-matching-group',
        lines: [{ lineId: 'line-a', amountMinor: 100 }],
      }])
    })
  },
})
