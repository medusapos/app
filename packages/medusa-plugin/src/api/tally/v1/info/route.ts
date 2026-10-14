import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { TALLY_LEDGER_MODULE } from '../../../../modules/tally-ledger'
import type TallyLedgerModuleService from '../../../../modules/tally-ledger/service'
import { approvalThresholdMinor, LINE_TAX, SUPPORTED_ORDER_CREATE_VERSIONS, SUPPORTED_REGISTER_VERSIONS, TAX_ROUNDING } from '../versions'

/** The contract versions this plugin accepts, read by TallyUI's Medusa connector at sign-in (ADR-062). */
// taxRounding sits beside contracts: it is a capability, not a versioned contract (TallyUI #309).
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const options = req.scope.resolve<TallyLedgerModuleService>(TALLY_LEDGER_MODULE).getPluginOptions()
  const sync = options.experimentalSync
  return res.json({ contracts: {
    'order.create': SUPPORTED_ORDER_CREATE_VERSIONS, register: SUPPORTED_REGISTER_VERSIONS, ...(sync ? { sync: [1] } : {}),
  }, taxRounding: TAX_ROUNDING, registerApproval: { thresholdMinor: approvalThresholdMinor(options) }, lineTax: LINE_TAX })
}
