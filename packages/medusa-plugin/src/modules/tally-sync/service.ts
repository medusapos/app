import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { EntityManager } from '@medusajs/framework/mikro-orm/postgresql'
import type { Context } from '@medusajs/framework/types'
import { InjectManager, MedusaContext, MedusaService } from '@medusajs/framework/utils'
import { TallyChange } from './models/tally-change'
import { TallySyncState } from './models/tally-sync-state'

// Fixed transaction advisory lock key reserved for tally_sync epoch creation and backfill.
const INITIALIZE_LOCK = 2026093009

// Postgres caps a statement at 65,535 parameters; this many rows (3 params each) stays well under it.
const RECORD_CHUNK_SIZE = 1000

export default class TallySyncModuleService extends MedusaService({ TallyChange, TallySyncState }) {
  @InjectManager()
  async record(changes: { collection: string; objectId: string; op: 'upsert' | 'delete' }[],
    @MedusaContext() sharedContext: Context = {}): Promise<void> {
    const unique = [...new Map(changes.map(c => [JSON.stringify([c.collection, c.objectId, c.op]), c])).values()]
    if (!unique.length) return
    const manager = sharedContext.manager as EntityManager
    for (let i = 0; i < unique.length; i += RECORD_CHUNK_SIZE) {
      const chunk = unique.slice(i, i + RECORD_CHUNK_SIZE)
      await manager.execute(
        `insert into tally_change (collection, object_id, op) values ${chunk.map(() => '(?, ?, ?)').join(', ')}`,
        chunk.flatMap(c => [c.collection, c.objectId, c.op]))
    }
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
    const head = await this.head(sharedContext)
    const pageSize = Math.min(limit, 1000)
    const filter = collections ? (collections.length ? `and collection in (${collections.map(() => '?').join(', ')})` : 'and false') : ''
    const rows = await (sharedContext.manager as EntityManager).execute(
      `select seq, collection, object_id as id, op from tally_change where seq > ? ${filter} order by seq limit ?`,
      [since, ...(collections ?? []), pageSize + 1])
    const changes = rows.slice(0, pageSize).map(row => {
      const seq = Number(row.seq)
      assert(Number.isSafeInteger(seq), 'tally_change seq exceeds safe integer range')
      return { seq, collection: row.collection, id: row.id, op: row.op }
    })
    return { head, changes, more: rows.length > pageSize }
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
      await em.execute('select pg_advisory_xact_lock(?)', [INITIALIZE_LOCK])
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
}
