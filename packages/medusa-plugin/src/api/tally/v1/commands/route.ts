import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import type { CommandBatchRequest } from '@tallyui/core'
import { TALLY_LEDGER_MODULE } from '../../../../modules/tally-ledger'
import type TallyLedgerModuleService from '../../../../modules/tally-ledger/service'
import { processBatch, validateBatch } from './process'

export async function POST(req: MedusaRequest<CommandBatchRequest>, res: MedusaResponse) {
  if (req.get('X-Tally-Protocol') !== '1') {
    return res.status(400).json({ code: 'unsupported_protocol' })
  }
  const batch = validateBatch(req.body)
  if (batch.ok === false) return res.status(batch.status).json({ message: batch.message })
  const ledger = req.scope.resolve<TallyLedgerModuleService>(TALLY_LEDGER_MODULE)
  const outcome = await processBatch(req.scope, batch.commands, ledger.getPluginOptions())
  return res.status(outcome.status).json(outcome.body)
}
