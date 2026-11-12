import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { TALLY_LEDGER_MODULE } from '../../../../../modules/tally-ledger'
import type TallyLedgerModuleService from '../../../../../modules/tally-ledger/service'
import { buildCouponContext } from '../../../../../workflows/tally-coupons/coupon-context'
import { priceCoupons } from '../../../../../workflows/tally-coupons/price-coupons'
import { parsePromotionsPreviewBody } from '../preview-body'

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const parsed = parsePromotionsPreviewBody(req.body)
  if (!parsed.ok) return res.status(400).json({ code: 'invalid_payload', message: parsed.message })
  const { codes, ...sale } = parsed.value
  const options = req.scope.resolve<TallyLedgerModuleService>(TALLY_LEDGER_MODULE).getPluginOptions()
  const context = await buildCouponContext(req.scope, options, sale)
  const priced = await priceCoupons(req.scope, context, codes)
  return res.json({ coupons: priced.map(coupon => coupon.ok
    ? { code: coupon.code, couponId: coupon.couponId, lines: coupon.lines }
    : { code: coupon.code, storeCode: coupon.storeCode, message: coupon.message }) })
}
