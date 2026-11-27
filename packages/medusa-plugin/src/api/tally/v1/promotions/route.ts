import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import { TALLY_LEDGER_MODULE } from '../../../../modules/tally-ledger'
import type TallyLedgerModuleService from '../../../../modules/tally-ledger/service'
import { saleChannelId } from '../../../../workflows/tally-order-create/sale-region'
import { tillCoupons } from './coupon-list'

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const currency = req.query.currency
  if (currency !== undefined && (typeof currency !== 'string' || !/^[a-z]{3}$/i.test(currency))) {
    return res.status(400).json({ code: 'invalid_currency' })
  }
  const options = req.scope.resolve<TallyLedgerModuleService>(TALLY_LEDGER_MODULE).getPluginOptions()
  const channelId = await saleChannelId(req.scope.resolve(ContainerRegistrationKeys.QUERY), options)
  const promotions = await req.scope.resolve(Modules.PROMOTION).listPromotions({ status: ['active'], is_automatic: false }, {
    relations: ['application_method', 'rules.values', 'campaign.budget'], take: null,
  })
  return res.json(tillCoupons(promotions, { channelId, currency, now: Date.now() }))
}
