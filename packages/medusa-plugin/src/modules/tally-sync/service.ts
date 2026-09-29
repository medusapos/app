import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { Knex } from '@medusajs/framework/mikro-orm/knex'
import type { EntityManager } from '@medusajs/framework/mikro-orm/postgresql'
import type { Context } from '@medusajs/framework/types'
import { InjectManager, MedusaContext, MedusaService } from '@medusajs/framework/utils'
import { TallyChange } from './models/tally-change'
import { TallySyncState } from './models/tally-sync-state'
import { resolveProductChanges } from './resolve-products'

// Transaction advisory lock key taken before every tally_change write (record, recordEvent, initialize).
// Held until commit, it serialises journal writers so seq order is commit order and a cursor never skips a row.
const JOURNAL_LOCK = 2026093009

// Bounds the wait for JOURNAL_LOCK so one stuck holder (a long backfill, an idle-in-transaction connection) cannot
// stall every queued event indefinitely. A timeout is an error: the subscriber logs it and moves on, so a
// timed-out event is logged but not journaled -- the digest audit (P3) is the backstop for that gap.
const JOURNAL_LOCK_TIMEOUT = '10s'

// Transaction advisory lock key for the price-list watcher, so concurrent runs never scan the same window twice.
// Lock order is always PRICE_LIST_WATCHER_LOCK, then JOURNAL_LOCK (inside record); nothing takes them the other way.
const PRICE_LIST_WATCHER_LOCK = 2026093010

// Postgres caps a statement at 65,535 parameters; this many rows (3 params each) stays well under it.
const RECORD_CHUNK_SIZE = 1000

export default class TallySyncModuleService extends MedusaService({ TallyChange, TallySyncState }) {
  @InjectManager()
  async record(changes: { collection: string; objectId: string; op: 'upsert' | 'delete' }[],
    @MedusaContext() sharedContext: Context = {}): Promise<number> {
    const unique = [...new Map(changes.map(c => [JSON.stringify([c.collection, c.objectId, c.op]), c])).values()]
    if (!unique.length) return 0
    return (sharedContext.manager as EntityManager).transactional(async em => {
      await em.execute(`set local lock_timeout = '${JOURNAL_LOCK_TIMEOUT}'`)
      await em.execute('select pg_advisory_xact_lock(?)', [JOURNAL_LOCK])
      for (let i = 0; i < unique.length; i += RECORD_CHUNK_SIZE) {
        const chunk = unique.slice(i, i + RECORD_CHUNK_SIZE)
        await em.execute(
          `insert into tally_change (collection, object_id, op) values ${chunk.map(() => '(?, ?, ?)').join(', ')}`,
          chunk.flatMap(c => [c.collection, c.objectId, c.op]))
      }
      return unique.length
    })
  }

  // Resolves an event to products and journals them under JOURNAL_LOCK, reading committed state on the
  // transaction's own connection, so a product's latest row reflects every write committed before it.
  @InjectManager()
  async recordEvent(eventName: string, id: string, @MedusaContext() sharedContext: Context = {}): Promise<number> {
    return (sharedContext.manager as EntityManager).transactional(async em => {
      await em.execute(`set local lock_timeout = '${JOURNAL_LOCK_TIMEOUT}'`)
      await em.execute('select pg_advisory_xact_lock(?)', [JOURNAL_LOCK])
      const changes = await resolveProductChanges(em.getTransactionContext<Knex.Transaction>()!, eventName, id)
      return this.record(changes.map(({ productId, op }) => ({ collection: 'products', objectId: productId, op })), { manager: em })
    })
  }

  @InjectManager()
  async head(@MedusaContext() sharedContext: Context = {}): Promise<number> {
    const [row] = await (sharedContext.manager as EntityManager).execute('select coalesce(max(seq), 0) as head from tally_change')
    const head = Number(row.head)
    assert(Number.isSafeInteger(head), 'tally_change head exceeds safe integer range')
    return head
  }

  @InjectManager()
  async changesSince({ since, limit, collections }: { since: number; limit: number; collections?: string[] },
    @MedusaContext() sharedContext: Context = {}): Promise<{
      head: number; changes: { seq: number; collection: string; id: string; op: 'upsert' | 'delete' }[]; more: boolean
    }> {
    const pageSize = Math.min(limit, 1000)
    const filter = collections ? (collections.length ? `and collection in (${collections.map(() => '?').join(', ')})` : 'and false') : ''
    // Read head before the rows: under JOURNAL_LOCK, rows commit in seq order, so anything that commits between
    // the two reads has seq > head and lands in this page (or a later one, via more) instead of being skipped.
    const head = await this.head(sharedContext)
    const rows = await (sharedContext.manager as EntityManager).execute(
      `select seq, collection, object_id as id, op from tally_change where seq > ? ${filter} order by seq limit ?`,
      [since, ...(collections ?? []), pageSize + 1])
    const changes = rows.slice(0, pageSize).map(row => {
      const seq = Number(row.seq)
      assert(Number.isSafeInteger(seq), 'tally_change seq exceeds safe integer range')
      return { seq, collection: row.collection, id: row.id, op: row.op }
    })
    return { head: Math.max(head, changes.at(-1)?.seq ?? 0), changes, more: rows.length > pageSize }
  }

  @InjectManager()
  async getState(@MedusaContext() sharedContext: Context = {}): Promise<{
    epoch: string; priceListWatermark: string | null; priceWindowRunAt: string | null
  } | null> {
    const [row] = await (sharedContext.manager as EntityManager).execute("select * from tally_sync_state where id = 'sync'")
    if (!row) return null
    return {
      epoch: row.epoch,
      priceListWatermark: row.price_list_watermark === null ? null : new Date(row.price_list_watermark).toISOString(),
      priceWindowRunAt: row.price_window_run_at === null ? null : new Date(row.price_window_run_at).toISOString(),
    }
  }

  @InjectManager()
  async initialize(productIds: string[], @MedusaContext() sharedContext: Context = {}): Promise<{ epoch: string; created: boolean }> {
    return (sharedContext.manager as EntityManager).transactional(async em => {
      await em.execute(`set local lock_timeout = '${JOURNAL_LOCK_TIMEOUT}'`)
      await em.execute('select pg_advisory_xact_lock(?)', [JOURNAL_LOCK])
      const [state] = await em.execute("select epoch from tally_sync_state where id = 'sync'")
      if (state) return { epoch: state.epoch, created: false }
      const epoch = randomUUID()
      await em.execute("insert into tally_sync_state (id, epoch) values ('sync', ?)", [epoch])
      await this.record(productIds.map(objectId => ({ collection: 'products', objectId, op: 'upsert' })), { manager: em })
      return { epoch, created: true }
    })
  }

  @InjectManager()
  async setPriceListWatermark(watermark: string | null, priceWindowRunAt: string | null,
    @MedusaContext() sharedContext: Context = {}): Promise<void> {
    await (sharedContext.manager as EntityManager).execute(
      "update tally_sync_state set price_list_watermark = ?, price_window_run_at = ?, updated_at = now() where id = 'sync'",
      [watermark, priceWindowRunAt])
  }

  // The price-list watcher's transaction (behaviour and known gap: runPriceListWatcher in sync-state.ts); returns rows written.
  @InjectManager()
  async watchPriceLists(@MedusaContext() sharedContext: Context = {}): Promise<number> {
    return (sharedContext.manager as EntityManager).transactional(async em => {
      // A run that times out waiting is logged by the caller and retried on the next tick or minute.
      await em.execute(`set local lock_timeout = '${JOURNAL_LOCK_TIMEOUT}'`)
      await em.execute('select pg_advisory_xact_lock(?)', [PRICE_LIST_WATCHER_LOCK])
      // Timestamps stay as text so the microsecond precision of Postgres survives the round trip.
      const [state] = await em.execute(`select now()::text as now, price_list_watermark::text as watermark,
        price_window_run_at::text as window_run_at from tally_sync_state where id = 'sync'`)
      if (!state) return 0
      const { now, watermark, window_run_at: windowRunAt } = state
      if (watermark === null || windowRunAt === null) {
        await this.setPriceListWatermark(watermark ?? now, windowRunAt ?? now, { manager: em })
        return 0
      }
      const [lists] = await em.execute(`select array_agg(id) as ids, greatest(max(updated_at), ?::timestamptz)::text as watermark
        from price_list where updated_at > ?::timestamptz
          or (starts_at > ?::timestamptz and starts_at <= ?::timestamptz) or (ends_at > ?::timestamptz and ends_at <= ?::timestamptz)`,
      [watermark, watermark, windowRunAt, now, windowRunAt, now])
      let written = 0
      if (lists.ids?.length) {
        // MikroORM inlines an array parameter as a comma list, so the ids go through `in (?)`.
        const products: { id: string; deleted_at: Date | null }[] = await em.execute(`select distinct product.id, product.deleted_at
          from price
          join product_variant_price_set as link on link.price_set_id = price.price_set_id
          join product_variant as variant on variant.id = link.variant_id
          join product on product.id = variant.product_id
          where price.price_list_id in (?)`, [lists.ids])
        written = await this.record(products.map(product => ({
          collection: 'products', objectId: product.id, op: product.deleted_at ? 'delete' as const : 'upsert' as const,
        })), { manager: em })
      }
      await this.setPriceListWatermark(lists.watermark, now, { manager: em })
      return written
    })
  }
}
