import type { PromotionDTO } from '@medusajs/framework/types'
import { MathBN } from '@medusajs/framework/utils'
import { currencyDecimals, majorToMinor } from '../../../../workflows/tally-order-create/money'

// Bound the till's picker response; codes beyond it can still be typed.
export const COUPON_LIST_LIMIT = 100

type TillCoupon = {
  code: string; label: string | null; type: 'percentage' | 'fixed'; value: number; currency: string | null; endsAt: string | null
}

export function tillCoupons(promotions: PromotionDTO[], { channelId, currency, now }: {
  channelId?: string; currency?: string; now: number
}) {
  const coupons: TillCoupon[] = []
  for (const promotion of promotions) {
    const { code, campaign, application_method: method } = promotion
    if (!code || promotion.is_automatic !== false || promotion.status !== 'active' || promotion.type === 'buyget' ||
      method?.target_type !== 'items' || method.value == null || (method.type !== 'fixed' && method.type !== 'percentage')) continue
    if ((campaign?.starts_at && new Date(campaign.starts_at).getTime() > now) ||
      (campaign?.ends_at && new Date(campaign.ends_at).getTime() < now)) continue
    if (promotion.limit != null && (promotion.used ?? 0) >= promotion.limit) continue
    const budget = campaign?.budget
    if (budget) {
      switch (budget.type) {
        case 'use_by_attribute': break
        case 'usage': case 'spend':
          if (budget.limit != null && MathBN.gte(budget.used ?? 0, budget.limit)) continue
          break
        case 'spend_by_attribute':
          if (budget.limit != null && MathBN.gt(MathBN.add(budget.used ?? 0, 1), budget.limit)) continue
          break
        default: continue
      }
    }
    if (promotion.rules?.some(rule => {
      if (rule.attribute !== 'sales_channel_id') return false
      if (!channelId) return true
      const named = rule.values.some(entry => entry.value === channelId)
      return rule.operator === 'ne' ? named : (rule.operator !== 'eq' && rule.operator !== 'in') || !named
    })) continue
    const unit = method.type === 'fixed' ? method.currency_code?.toLowerCase() : null
    if (method.type === 'fixed' && (!unit || (currency && unit !== currency.toLowerCase()))) continue
    coupons.push({ code, label: campaign?.name ?? null, type: method.type, currency: unit ?? null,
      value: unit ? majorToMinor(String(method.value), currencyDecimals(unit)) : Number(method.value),
      endsAt: campaign?.ends_at ? new Date(campaign.ends_at).toISOString() : null })
  }
  coupons.sort((left, right) => left.code < right.code ? -1 : left.code > right.code ? 1 : 0)
  return { coupons: coupons.slice(0, COUPON_LIST_LIMIT), limit: COUPON_LIST_LIMIT, truncated: coupons.length > COUPON_LIST_LIMIT }
}
