import type { Logger, MedusaContainer } from '@medusajs/framework/types'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { TALLY_SYNC_MODULE } from '.'
import type TallySyncModuleService from './service'

// Minimum gap between unforced watcher runs in this process, so every till's tick does not rescan price lists.
const WATCHER_THROTTLE_MS = 5000
// Per-process time of the last watcher run (ms since epoch); each server process throttles on its own.
let lastWatcherRunAt = 0

export async function ensureInitialized(container: MedusaContainer): Promise<{ epoch: string }> {
  const sync = container.resolve<TallySyncModuleService>(TALLY_SYNC_MODULE)
  const state = await sync.getState()
  if (state) return { epoch: state.epoch }
  const { epoch } = await sync.initialize()
  return { epoch }
}

/**
 * Journals the products of price lists edited since the watermark, or whose starts_at or ends_at passed since the
 * last run: price-list edits emit no event and a sale starting or ending writes nothing.
 * Known gap: the watermark trails now() by 10 s, so a price-list write whose transaction commits (or whose app clock
 * skews) longer than that after its updated_at is missed until that list's next edit.
 */
export async function runPriceListWatcher(container: MedusaContainer, { force = false }: { force?: boolean } = {}): Promise<void> {
  if (!force && Date.now() - lastWatcherRunAt < WATCHER_THROTTLE_MS) return
  lastWatcherRunAt = Date.now()
  let logger: Logger | undefined
  try {
    logger = container.resolve<Logger>(ContainerRegistrationKeys.LOGGER)
    await container.resolve<TallySyncModuleService>(TALLY_SYNC_MODULE).watchPriceLists()
  } catch (error) {
    logger?.error(`tally_sync: price-list watcher failed: ${error}`)
  }
}
