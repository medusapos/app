import type { Knex } from '@medusajs/framework/mikro-orm/knex'
import type { Logger, MedusaContainer } from '@medusajs/framework/types'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { TALLY_SYNC_MODULE } from '.'
import type TallySyncModuleService from './service'

// Fixed transaction advisory lock key for the price-list watcher, distinct from the service's initialize key (2026093009).
const PRICE_LIST_WATCHER_LOCK = 2026093010

// Minimum gap between unforced watcher runs in this process, so every till's tick does not rescan price lists.
const WATCHER_THROTTLE_MS = 5000
// Per-process time of the last watcher run (ms since epoch); each server process throttles on its own.
let lastWatcherRunAt = 0

export async function ensureInitialized(container: MedusaContainer): Promise<{ epoch: string }> {
  const sync = container.resolve<TallySyncModuleService>(TALLY_SYNC_MODULE)
  const state = await sync.getState()
  if (state) return { epoch: state.epoch }
  const knex = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION)
  const rows: { id: string }[] = await knex.raw('select id from product where deleted_at is null order by id').then(r => r.rows)
  const { epoch, created } = await sync.initialize(rows.map(row => row.id))
  if (created) {
    // The backfill covers every price list edited or scheduled before this point.
    const [{ now }] = (await knex.raw('select now()::text as now')).rows
    await sync.setPriceListWatermark(now, now)
  }
  return { epoch }
}

/**
 * Journals the products of price lists edited since the watermark, or whose starts_at or ends_at passed since the
 * last run: price-list edits emit no event and a sale starting or ending writes nothing.
 * Known gap: the watermark is strict, so a price-list write whose transaction commits after the watermark has passed
 * its updated_at is missed until that list's next edit.
 */
export async function runPriceListWatcher(container: MedusaContainer, { force = false }: { force?: boolean } = {}): Promise<void> {
  if (!force && Date.now() - lastWatcherRunAt < WATCHER_THROTTLE_MS) return
  lastWatcherRunAt = Date.now()
  let logger: Logger | undefined
  try {
    logger = container.resolve<Logger>(ContainerRegistrationKeys.LOGGER)
    const sync = container.resolve<TallySyncModuleService>(TALLY_SYNC_MODULE)
    await container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION).transaction(async trx => {
      const execute = async (sql: string, params: unknown[] = []) => (await trx.raw(sql, params as Knex.RawBinding[])).rows
      // The service methods run their SQL through `manager.execute`, so this keeps their writes in this transaction.
      const context = { manager: { execute } }
      await execute('select pg_advisory_xact_lock(?)', [PRICE_LIST_WATCHER_LOCK])
      // Timestamps stay as text so the microsecond precision of Postgres survives the round trip.
      const [state] = await execute(`select now()::text as now, price_list_watermark::text as watermark,
        price_window_run_at::text as window_run_at from tally_sync_state where id = 'sync'`)
      if (!state) return
      const { now, watermark, window_run_at: windowRunAt } = state
      if (watermark === null || windowRunAt === null) {
        await sync.setPriceListWatermark(watermark ?? now, windowRunAt ?? now, context)
        return
      }
      const [lists] = await execute(`select array_agg(id) as ids, greatest(max(updated_at), ?::timestamptz)::text as watermark
        from price_list where updated_at > ?::timestamptz
          or (starts_at > ?::timestamptz and starts_at <= ?::timestamptz) or (ends_at > ?::timestamptz and ends_at <= ?::timestamptz)`,
      [watermark, watermark, windowRunAt, now, windowRunAt, now])
      if (lists.ids?.length) {
        const products: { id: string; deleted_at: Date | null }[] = await execute(`select distinct product.id, product.deleted_at
          from price
          join product_variant_price_set as link on link.price_set_id = price.price_set_id
          join product_variant as variant on variant.id = link.variant_id
          join product on product.id = variant.product_id
          where price.price_list_id = any(?::text[])`, [lists.ids])
        await sync.record(products.map(product => ({
          collection: 'products', objectId: product.id, op: product.deleted_at ? 'delete' as const : 'upsert' as const,
        })), context)
      }
      await sync.setPriceListWatermark(lists.watermark, now, context)
    })
  } catch (error) {
    logger?.error(`tally_sync: price-list watcher failed: ${error}`)
  }
}
