import { messages } from './price-coupons'

export class CouponUsageError extends Error {
  name = 'TallyCouponUsageError'
  code = 'coupon_invalid' as const
  data: { couponCode: string; storeCode: 'limit_reached' | 'budget_exceeded' }
  constructor(couponCode: string, storeCode: 'limit_reached' | 'budget_exceeded') {
    super(messages[storeCode])
    this.data = { couponCode, storeCode }
  }
}
export function isCouponUsageError(error: unknown): error is CouponUsageError {
  const value = error as Partial<CouponUsageError> | null
  return value?.name === 'TallyCouponUsageError' && value.code === 'coupon_invalid'
    && (value.data?.storeCode === 'limit_reached' || value.data?.storeCode === 'budget_exceeded')
}
