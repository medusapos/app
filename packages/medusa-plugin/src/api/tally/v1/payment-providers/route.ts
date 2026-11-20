import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { Modules } from '@medusajs/framework/utils'
import { SYSTEM_PROVIDER_ID } from '../../../../workflows/tally-order-create/resume'

function providerName(id: string) {
  if (id === SYSTEM_PROVIDER_ID) return 'Manual payment'
  const match = /^pp_(.+)_[^_]+$/.exec(id)
  if (!match) return id
  return match[1].split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
}

/** The store's enabled payment providers for the till's Settings › Card readers (v2 row 15d), read-only. */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const providers = await req.scope.resolve(Modules.PAYMENT).listPaymentProviders({ is_enabled: true })
  return res.json({ providers: providers
    .map(({ id }) => ({ id, name: providerName(id), tillCanTake: id === SYSTEM_PROVIDER_ID }))
    .sort((a, b) => Number(b.tillCanTake) - Number(a.tillCanTake) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) })
}
