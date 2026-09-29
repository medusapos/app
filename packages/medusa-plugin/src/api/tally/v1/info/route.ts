import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { TALLY_LEDGER_MODULE } from '../../../../modules/tally-ledger'
import type TallyLedgerModuleService from '../../../../modules/tally-ledger/service'
import { SUPPORTED_ORDER_CREATE_VERSIONS, SUPPORTED_REGISTER_VERSIONS } from '../versions'

/** The contract versions this plugin accepts, read by TallyUI's Medusa connector at sign-in (ADR-062). */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const sync = req.scope.resolve<TallyLedgerModuleService>(TALLY_LEDGER_MODULE).getPluginOptions().experimentalSync
  return res.json({ contracts: {
    'order.create': SUPPORTED_ORDER_CREATE_VERSIONS, register: SUPPORTED_REGISTER_VERSIONS, ...(sync ? { sync: [1] } : {}),
  } })
}
