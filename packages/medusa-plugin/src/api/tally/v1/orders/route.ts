import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import type { StoreOrderPage } from '@tallyui/core' with { 'resolution-mode': 'import' }
import { TALLY_LEDGER_MODULE } from '../../../../modules/tally-ledger'
import type TallyLedgerModuleService from '../../../../modules/tally-ledger/service'
import { saleChannelId } from '../../../../workflows/tally-order-create/sale-region'
import { ORDER_FIELDS, orderFilters, orderPage, parseOrdersQuery, type OrderRow } from './list'

/** The till's channel orders (allChannels=true lists every channel), newest first, as TallyUI's StoreOrderPage (read-only). */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const parsed = parseOrdersQuery(req.query)
  if (!parsed.ok) return res.status(400).json(parsed.error)
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  let filters: Record<string, unknown> | null
  if (parsed.query.allChannels) {
    filters = orderFilters(parsed.query, 'all')
  } else {
    const options = req.scope.resolve<TallyLedgerModuleService>(TALLY_LEDGER_MODULE).getPluginOptions()
    const channelId = await saleChannelId(query, options)
    filters = channelId ? orderFilters(parsed.query, { salesChannelId: channelId }) : null
  }
  if (!filters) return res.json({ orders: [], hasMore: false, total: 0 } satisfies StoreOrderPage)
  const { page, perPage } = parsed.query
  const { data, metadata } = await query.graph({
    entity: 'order', fields: ORDER_FIELDS, filters,
    pagination: { skip: (page - 1) * perPage, take: perPage, order: { created_at: 'DESC', id: 'DESC' } },
  })
  return res.json(orderPage(data as unknown as OrderRow[], metadata?.count ?? 0, parsed.query) satisfies StoreOrderPage)
}
