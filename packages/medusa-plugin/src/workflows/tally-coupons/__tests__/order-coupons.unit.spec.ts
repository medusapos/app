import type { OrderCreateCoupon, OrderCreatePayload } from '@tallyui/core' with { 'resolution-mode': 'import' }
import inclusive from '../../tally-order-create/__fixtures__/order-create-coupon-envelopes-2026-11-12/inclusive-coupon.json'
import repro from '../../tally-order-create/__fixtures__/order-create-coupon-envelopes-2026-11-12/inclusive-line-discount-coupon.json'
import type { CouponLine } from '../coupon-context'
import type { CouponPriced, CouponPricing } from '../price-coupons'
import { couponAmountError, orderCouponSale, type OrderCouponError } from '../order-coupons'

it('refuses the 3.19.0 repro, a coupon beside a tax-inclusive line discount (990 vs 971)', () => {
  // When the plugin accepts the version with per-line coupon amounts, this case's recording
  // at that version joins this test and is expected to pass at 971.
  expect(orderCouponSale(repro.payload as OrderCreatePayload)).toEqual({ ok: false, error: {
    code: 'coupon_invalid', message: "This coupon can't be combined with a discount on a tax-inclusive item yet.",
    data: { couponCode: 'c', storeCode: 'not_applicable' },
  } })
})

it('builds the sale from the 3.19.0 inclusive coupon envelope', () => {
  expect(orderCouponSale(inclusive.payload as OrderCreatePayload)).toEqual({ ok: true, sale: {
    currency: 'EUR', lines: [{ lineId: inclusive.payload.lines[0].clientLineId,
      variantId: 'VARIANT', quantity: 1, taxInclusive: true, netMinor: 1190 }],
  } })
})

it("nets an exclusive line's discount and carries the location and customer", () => {
  const payload = structuredClone(inclusive.payload) as OrderCreatePayload
  Object.assign(payload, { pricesIncludeTax: false, locationId: 'sloc_1', customer: { customerId: 'cus_1' } })
  Object.assign(payload.lines[0], { unitPriceMinor: 500, quantity: 2, discountMinor: 100 })
  payload.lines.push({ clientLineId: 'custom-1', custom: { name: 'Gift wrap', taxStatus: 'taxable' }, quantity: 1, unitPriceMinor: 300 })
  expect(orderCouponSale(payload)).toEqual({ ok: true, sale: {
    currency: 'EUR', locationId: 'sloc_1', customerId: 'cus_1', lines: [
      { lineId: payload.lines[0].clientLineId, variantId: 'VARIANT', quantity: 2, taxInclusive: false, netMinor: 900 },
      { lineId: 'custom-1', quantity: 1, taxInclusive: false, netMinor: 300 },
    ],
  } })
})

it('leaves an exclusive discounted line beside a coupon alone in an inclusive order', () => {
  const payload = structuredClone(repro.payload) as OrderCreatePayload
  payload.lines[0].taxInclusive = false
  expect(orderCouponSale(payload)).toEqual({ ok: true, sale: {
    currency: 'EUR', lines: [{ lineId: payload.lines[0].clientLineId,
      variantId: 'VARIANT', quantity: 1, taxInclusive: false, netMinor: 1190 - 84 }],
  } })
})

it('refuses an inclusive discounted line beside a coupon in an exclusive order', () => {
  const payload = structuredClone(repro.payload) as OrderCreatePayload
  payload.pricesIncludeTax = false
  payload.lines[0].taxInclusive = true
  expect(orderCouponSale(payload)).toEqual({ ok: false, error: {
    code: 'coupon_invalid', message: "This coupon can't be combined with a discount on a tax-inclusive item yet.",
    data: { couponCode: 'c', storeCode: 'not_applicable' },
  } })
})

it("couponAmountError compares in the lines' own mode", () => {
  const line: CouponLine = { lineId: 'line-1', quantity: 1, taxInclusive: true, netMinor: 1190 }
  const exclusive = { ...line, taxInclusive: false }
  const coupon: OrderCreateCoupon = { code: 'c', couponId: 'PROMO', discountMinor: 84, discountTaxMinor: 16 }
  const netCoupon = { ...coupon, discountMinor: 100, discountTaxMinor: 19 }
  const pricing: CouponPriced = { code: 'c', ok: true, couponId: 'PROMO', promotionCode: 'c',
    lines: [{ lineId: 'line-1', amountMinor: 100 }], actions: [] }
  const changed = { ...pricing, lines: [{ lineId: 'line-1', amountMinor: 119 }] }
  const mismatch: OrderCouponError = { code: 'coupon_invalid', message: "This coupon's amount has changed since it was applied.",
    data: { couponCode: 'c', storeCode: 'amount_mismatch' } }
  const cases: Array<{ coupon: OrderCreateCoupon; pricing: CouponPricing; lines: CouponLine[]; error: OrderCouponError | null }> = [
    { coupon, pricing, lines: [line], error: null },
    { coupon, pricing: changed, lines: [line], error: mismatch },
    { coupon: netCoupon, pricing, lines: [exclusive], error: null },
    { coupon: netCoupon, pricing: changed, lines: [exclusive], error: mismatch },
    { coupon, pricing: { ...pricing, couponId: 'promo_other' }, lines: [line], error: {
      code: 'coupon_invalid', message: "This coupon code isn't known to the store.",
      data: { couponCode: 'c', storeCode: 'not_found' },
    } },
    { coupon, pricing: { ...pricing, lines: [...pricing.lines, { lineId: 'line-2', amountMinor: 1 }] },
      lines: [line, { ...exclusive, lineId: 'line-2' }], error: {
        code: 'coupon_invalid', message: "This coupon can't be used at the till yet",
        data: { couponCode: 'c', storeCode: 'not_applicable' },
      } },
    { coupon, pricing: { code: 'c', ok: false, storeCode: 'limit_reached', message: 'This coupon has been used up.' },
      lines: [line], error: { code: 'coupon_invalid', message: 'This coupon has been used up.',
        data: { couponCode: 'c', storeCode: 'limit_reached' } } },
  ]
  for (const test of cases) expect(couponAmountError(test.coupon, test.pricing, test.lines)).toEqual(test.error)
})
