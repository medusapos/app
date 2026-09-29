import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { TALLY_LEDGER_MODULE } from '../../../../../modules/tally-ledger'
import type TallyLedgerModuleService from '../../../../../modules/tally-ledger/service'
import { HORIZON, TALLY_SYNC_MODULE } from '../../../../../modules/tally-sync'
import type TallySyncModuleService from '../../../../../modules/tally-sync/service'
import { ensureInitialized, runPriceListWatcher } from '../../../../../modules/tally-sync/sync-state'

/** Cheap poll for the journal head: 304 when the caller's epoch and since are current (ADR 0020 §3, experimental). */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  if (!req.scope.resolve<TallyLedgerModuleService>(TALLY_LEDGER_MODULE).getPluginOptions().experimentalSync) {
    return res.status(404).json({ message: 'Not found' })
  }
  const { epoch } = await ensureInitialized(req.scope)
  await runPriceListWatcher(req.scope)
  const head = await req.scope.resolve<TallySyncModuleService>(TALLY_SYNC_MODULE).head()
  if (req.query.epoch === epoch && req.query.since === String(head)) return res.status(304).end()
  return res.json({ epoch, head, horizon: HORIZON })
}
