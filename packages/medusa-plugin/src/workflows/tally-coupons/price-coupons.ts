import type { AddItemAdjustmentAction, MedusaContainer, PromotionDTO } from '@medusajs/framework/types'
import { MathBN, Modules } from '@medusajs/framework/utils'
import { escapeLike } from '../tally-order-create/customer-email'
import { majorToMinor } from '../tally-order-create/money'
import type { CouponContext } from './coupon-context'

export type CouponStoreCode = 'not_found' | 'not_active' | 'not_applicable' | 'limit_reached' | 'budget_exceeded' | 'amount_mismatch'
export type CouponPriced = {
  code: string; ok: true; couponId: string; promotionCode: string
  lines: Array<{ lineId: string; amountMinor: number }>
  actions: AddItemAdjustmentAction[]
}
export type CouponRefused = { code: string; ok: false; storeCode: CouponStoreCode; message: string }
export type CouponPricing = CouponPriced | CouponRefused

const messages = {
  not_found: "This coupon code isn't known to the store.",
  not_active: "This coupon isn't active right now.",
  not_applicable: "This coupon doesn't apply to this sale.",
  limit_reached: 'This coupon has been used up.',
  budget_exceeded: "This coupon's budget has run out.",
}

export async function priceCoupons(
  container: MedusaContainer, context: CouponContext, codes: string[],
): Promise<CouponPricing[]> {
  const promotions = container.resolve(Modules.PROMOTION)
  const resolved: Array<CouponRefused | { code: string; promotion: PromotionDTO }> = []
  const now = Date.now()
  for (const code of codes) {
    const matches = await promotions.listPromotions({ code: { $ilike: escapeLike(code) } }, {
      relations: ['application_method', 'campaign'], take: null,
    })
    const promotion = matches.find(match => match.code === code) ?? (matches.length === 1 ? matches[0] : undefined)
    if (!promotion) {
      resolved.push({ code, ok: false, storeCode: 'not_found', message: messages.not_found })
      continue
    }
    const campaign = promotion.campaign
    if (promotion.status !== 'active' ||
      (campaign?.starts_at && new Date(campaign.starts_at).getTime() > now) ||
      (campaign?.ends_at && new Date(campaign.ends_at).getTime() < now)) {
      resolved.push({ code, ok: false, storeCode: 'not_active', message: messages.not_active })
    } else if (promotion.type === 'buyget' || promotion.application_method?.target_type !== 'items') {
      resolved.push({ code, ok: false, storeCode: 'not_applicable', message: "This coupon can't be used at the till yet" })
    } else {
      resolved.push({ code, promotion })
    }
  }
  const computed = await promotions.computeActions(
    resolved.flatMap(result => 'promotion' in result ? [result.promotion.code!] : []),
    context.compute, { prevent_auto_promotions: true },
  )
  return resolved.map(result => {
    if ('ok' in result) return result
    const { code, promotion } = result
    const actionsForCode = computed.filter(action => action.code === promotion.code)
    const storeCode = actionsForCode.some(action => action.action === 'promotionLimitExceeded') ? 'limit_reached'
      : actionsForCode.some(action => action.action === 'campaignBudgetExceeded') ? 'budget_exceeded' : undefined
    if (storeCode) return { code, ok: false, storeCode, message: messages[storeCode] }
    const actions = actionsForCode.filter((action): action is AddItemAdjustmentAction => action.action === 'addItemAdjustment')
    const lines = actions.map(action => {
      const line = context.lines.find(line => line.lineId === action.item_id)!
      const item = context.compute.items!.find(item => item.id === action.item_id)!
      let amount = MathBN.convert(action.amount)
      if (!!action.is_tax_inclusive !== line.taxInclusive) {
        const ratio = line.taxInclusive ? MathBN.div(item.original_total, item.subtotal)
          : MathBN.div(item.subtotal, item.original_total)
        amount = MathBN.mult(amount, ratio)
      }
      return { lineId: line.lineId, amountMinor: majorToMinor(amount.toString(), context.decimals) }
    }).filter(line => line.amountMinor !== 0)
    if (!lines.length) return { code, ok: false, storeCode: 'not_applicable', message: messages.not_applicable }
    return { code, ok: true, couponId: promotion.id, promotionCode: promotion.code!, lines, actions }
  })
}
