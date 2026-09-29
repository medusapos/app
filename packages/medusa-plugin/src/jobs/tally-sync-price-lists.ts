import type { MedusaContainer } from '@medusajs/framework/types'
import { TALLY_LEDGER_MODULE } from '../modules/tally-ledger'
import type TallyLedgerModuleService from '../modules/tally-ledger/service'
import { runPriceListWatcher } from '../modules/tally-sync/sync-state'

/** Catches price-list sales starting or ending when no till is ticking (experimentalSync). */
export default async function tallySyncPriceLists(container: MedusaContainer) {
  if (!container.resolve<TallyLedgerModuleService>(TALLY_LEDGER_MODULE).getPluginOptions().experimentalSync) return
  await runPriceListWatcher(container, { force: true })
}

export const config = { name: 'tally-sync-price-lists', schedule: '* * * * *' }
