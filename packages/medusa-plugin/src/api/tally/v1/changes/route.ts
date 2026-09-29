import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { TALLY_LEDGER_MODULE } from '../../../../modules/tally-ledger'
import type TallyLedgerModuleService from '../../../../modules/tally-ledger/service'
import { HORIZON, TALLY_SYNC_MODULE } from '../../../../modules/tally-sync'
import type TallySyncModuleService from '../../../../modules/tally-sync/service'
import { ensureInitialized } from '../../../../modules/tally-sync/sync-state'

function integer(value: unknown, fallback: number): number | undefined {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

/** Experimental, unversioned change feed over the tally_sync journal (ADR 0020 §3). */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  if (!req.scope.resolve<TallyLedgerModuleService>(TALLY_LEDGER_MODULE).getPluginOptions().experimentalSync) {
    return res.status(404).json({ message: 'Not found' })
  }
  const { since: rawSince, limit: rawLimit, collections: rawCollections, epoch: rawEpoch } = req.query
  const since = integer(rawSince, 0)
  const limit = integer(rawLimit, 500)
  if (since === undefined) return res.status(400).json({ message: 'since must be an integer >= 0' })
  if (limit === undefined || limit < 1 || limit > 1000) return res.status(400).json({ message: 'limit must be an integer from 1 to 1000' })
  if (rawCollections !== undefined && typeof rawCollections !== 'string') return res.status(400).json({ message: 'collections must be a comma list' })
  if (rawEpoch !== undefined && typeof rawEpoch !== 'string') return res.status(400).json({ message: 'epoch must be a string' })

  const { epoch } = await ensureInitialized(req.scope)
  const sync = req.scope.resolve<TallySyncModuleService>(TALLY_SYNC_MODULE)
  const collections = rawCollections === undefined ? undefined : rawCollections.split(',').filter(Boolean)
  const page = await sync.changesSince({ since, limit, collections })
  // A till that lost its epoch (no epoch given, but since > 0) resyncs the same way as one with a stale epoch.
  if ((since > 0 && rawEpoch === undefined) || (rawEpoch !== undefined && rawEpoch !== epoch) || since < HORIZON || since > page.head) {
    return res.status(410).json({ code: 'cursor_expired', epoch, head: page.head })
  }
  return res.json({
    epoch, head: page.head, horizon: HORIZON,
    changes: page.changes.map(change => ({ ...change, revision: change.seq })), more: page.more,
  })
}
