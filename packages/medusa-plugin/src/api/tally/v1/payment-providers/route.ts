import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import { TALLY_LEDGER_MODULE } from '../../../../modules/tally-ledger'
import type TallyLedgerModuleService from '../../../../modules/tally-ledger/service'
import { providerRows } from './providers'

type RegionProviders = { payment_providers?: Array<{ id: string; is_enabled: boolean } | null> | null }

/**
 * The store's enabled payment providers for the till's Settings › Card readers (v2 row 15d), read-only.
 * With `region_id`, only the enabled providers linked to that region (contract 6).
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const regionId = req.query.region_id
  if (regionId !== undefined && typeof regionId !== 'string') return res.status(400).json({ code: 'invalid_region_id' })
  const { terminalProviders } = req.scope.resolve<TallyLedgerModuleService>(TALLY_LEDGER_MODULE).getPluginOptions()
  if (!regionId) {
    const providers = await req.scope.resolve(Modules.PAYMENT).listPaymentProviders({ is_enabled: true })
    return res.json({ providers: providerRows(providers.map(({ id }) => id), terminalProviders) })
  }
  const { data: [region] } = await req.scope.resolve(ContainerRegistrationKeys.QUERY).graph({ entity: 'region',
    fields: ['id', 'payment_providers.id', 'payment_providers.is_enabled'], filters: { id: regionId } })
  if (!region) return res.status(404).json({ code: 'region_not_found' })
  const linked = ((region as RegionProviders).payment_providers ?? []).filter(provider => provider?.is_enabled)
  return res.json({ providers: providerRows(linked.map(provider => provider!.id), terminalProviders) })
}
