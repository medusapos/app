import type { MedusaContainer } from '@medusajs/framework/types'
import { MathBN } from '@medusajs/framework/utils'
import type { OrderCreateCoupon, OrderCreatePayload } from '@tallyui/core' with { 'resolution-mode': 'import' }
import type { TallyPluginOptions } from '../tally-order-create/run'
import { buildCouponContext, type CouponLine, type CouponSale } from './coupon-context'
import { messages, priceCoupons, type CouponPricing, type CouponStoreCode } from './price-coupons'

export type OrderCouponError = {
  code: 'coupon_invalid'; message: string; data: { couponCode: string; storeCode: CouponStoreCode }
}
export type CouponWrite = {
  couponCode: string; promotionId: string; promotionCode: string
  lines: Array<{ lineId: string; amountMinor: number; taxInclusive: boolean }>
  actions: Array<{ amount: string }>
}

/** Pure. The coupon sale the payload describes, or the ruling's refusal. */
export function orderCouponSale(payload: OrderCreatePayload): { ok: true; sale: CouponSale } | { ok: false; error: OrderCouponError } {
  // Front desk ruling, 2026-11-12, TallyUI #787: lift this guard when a payload version
  // carries per-line coupon amounts (order.create v9).
  if (payload.coupons?.length && payload.lines.some(line =>
    (line.taxInclusive ?? payload.pricesIncludeTax) === true && (line.discountMinor ?? 0) > 0)) {
    return { ok: false, error: {
      code: 'coupon_invalid', message: "This coupon can't be combined with a discount on a tax-inclusive item yet.",
      data: { couponCode: payload.coupons[0].code, storeCode: 'not_applicable' },
    } }
  }
  return { ok: true, sale: {
    currency: payload.currency,
    ...(typeof payload.locationId === 'string' ? { locationId: payload.locationId } : {}),
    ...(typeof payload.customer?.customerId === 'string' ? { customerId: payload.customer.customerId } : {}),
    lines: payload.lines.map(line => {
      const taxInclusive = line.taxInclusive ?? payload.pricesIncludeTax
      return {
        lineId: line.clientLineId,
        ...(typeof line.variantId === 'string' ? { variantId: line.variantId } : {}),
        quantity: line.quantity, taxInclusive,
        netMinor: line.unitPriceMinor * line.quantity - (taxInclusive ? 0 : line.discountMinor ?? 0),
      }
    }),
  } }
}

/** Pure. Why the store's pricing of one coupon differs from the till's figures, or null. */
export function couponAmountError(coupon: OrderCreateCoupon, pricing: CouponPricing, lines: CouponLine[]): OrderCouponError | null {
  if (pricing.ok === false) return {
    code: 'coupon_invalid', message: pricing.message, data: { couponCode: coupon.code, storeCode: pricing.storeCode },
  }
  if (pricing.couponId !== coupon.couponId) return {
    code: 'coupon_invalid', message: messages.not_found, data: { couponCode: coupon.code, storeCode: 'not_found' },
  }
  const modes = pricing.lines.map(priced => lines.find(line => line.lineId === priced.lineId)!.taxInclusive)
  if (modes.some(mode => mode) && modes.some(mode => !mode)) return {
    code: 'coupon_invalid', message: "This coupon can't be used at the till yet",
    data: { couponCode: coupon.code, storeCode: 'not_applicable' },
  }
  const expected = coupon.discountMinor + (modes.every(mode => mode) ? coupon.discountTaxMinor : 0)
  // Integer minor units: ADR 0025's half-minor-unit tolerance requires equality.
  if (pricing.lines.reduce((sum, line) => sum + line.amountMinor, 0) !== expected) return {
    code: 'coupon_invalid', message: "This coupon's amount has changed since it was applied.",
    data: { couponCode: coupon.code, storeCode: 'amount_mismatch' },
  }
  return null
}

// Pre-flight fixes the coupon amounts before the ledger claim.
export async function orderCoupons(
  container: MedusaContainer, options: TallyPluginOptions, payload: OrderCreatePayload,
): Promise<{ ok: false; error: OrderCouponError } | { ok: true; writes: CouponWrite[] }> {
  const result = orderCouponSale(payload)
  if (result.ok === false) return result
  const context = await buildCouponContext(container, options, result.sale)
  const coupons = payload.coupons!
  const pricings = await priceCoupons(container, context, coupons.map(coupon => coupon.code))
  const writes: CouponWrite[] = []
  for (let i = 0; i < coupons.length; i++) {
    const error = couponAmountError(coupons[i], pricings[i], result.sale.lines)
    if (error) return { ok: false, error }
    const pricing = pricings[i]
    if (pricing.ok) writes.push({ couponCode: coupons[i].code, promotionId: pricing.couponId, promotionCode: pricing.promotionCode,
      lines: pricing.lines.map(line => ({ ...line, taxInclusive: result.sale.lines.find(item => item.lineId === line.lineId)!.taxInclusive })),
      actions: pricing.actions.map(action => ({ ...action, amount: MathBN.convert(action.amount).toString() })),
    })
  }
  return { ok: true, writes }
}
