import { moduleIntegrationTestRunner } from '@medusajs/test-utils'
import { HORIZON, TALLY_SYNC_MODULE } from '..'
import TallySyncModuleService, { setJournalLockTimeoutForTests } from '../service'

moduleIntegrationTestRunner<TallySyncModuleService>({
  moduleName: TALLY_SYNC_MODULE,
  resolve: './src/modules/tally-sync',
  pathToMigrations: './src/modules/tally-sync/migrations',
  testSuite: ({ service, MikroOrmWrapper }) => {
    const sql = (query: string) => MikroOrmWrapper.forkManager().execute(query)
    const product = { collection: 'products', objectId: 'p1', op: 'upsert' as const }

    it('record inserts increasing seq, drops exact duplicates within a call, and ignores empty calls', async () => {
      await service.record([product, product, { ...product, op: 'delete' }, { ...product, objectId: 'p2' }])
      const rows = await sql('select seq, collection, object_id, op from tally_change order by seq')
      expect(rows.map(({ seq, ...row }) => row)).toEqual([
        { collection: 'products', object_id: 'p1', op: 'upsert' },
        { collection: 'products', object_id: 'p1', op: 'delete' },
        { collection: 'products', object_id: 'p2', op: 'upsert' },
      ])
      expect(Number(rows[1].seq)).toBeGreaterThan(Number(rows[0].seq))
      expect(Number(rows[2].seq)).toBeGreaterThan(Number(rows[1].seq))
      await service.record([])
      expect(await sql('select seq, collection, object_id, op from tally_change order by seq')).toEqual(rows)
      await service.record([product])
      expect(await sql('select seq from tally_change')).toHaveLength(4)
    })

    it('record of 2,500 distinct changes inserts 2,500 rows in input order', async () => {
      const changes = Array.from({ length: 2500 }, (_, i) => ({ ...product, objectId: `chunk${i}` }))
      await service.record(changes)
      const rows = await sql('select object_id from tally_change order by seq')
      expect(rows.map(row => row.object_id)).toEqual(changes.map(change => change.objectId))
    })

    it('head is zero when empty and then equals the last seq', async () => {
      expect(HORIZON).toBe(0)
      expect(await service.head()).toBe(0)
      await service.record([product, { ...product, objectId: 'p2' }])
      const [last] = await sql('select seq from tally_change order by seq desc limit 1')
      expect(await service.head()).toBe(Number(last.seq))
    })

    it('changesSince honours since, limit, the 1000 cap, collections, and more', async () => {
      await service.record(Array.from({ length: 1002 }, (_, i) => ({ ...product, objectId: `p${i}` })))
      await service.record([{ collection: 'prices', objectId: 'price1', op: 'delete' }])
      const head = await service.head()
      const first = await service.changesSince({ since: 0, limit: 1 })
      expect(first).toEqual({ head, changes: [{ seq: expect.any(Number), collection: 'products', id: 'p0', op: 'upsert' }], more: true })
      const capped = await service.changesSince({ since: first.changes[0].seq, limit: 2000, collections: ['products'] })
      expect(capped.changes).toHaveLength(1000)
      expect(capped.more).toBe(true)
      expect(capped.head).toBe(head)
      expect(capped.changes[0].id).toBe('p1')
      const last = await service.changesSince({ since: capped.changes[999].seq, limit: 1000, collections: ['products'] })
      expect(last).toEqual({ head, changes: [{ seq: expect.any(Number), collection: 'products', id: 'p1001', op: 'upsert' }], more: false })
      expect(await service.changesSince({ since: 0, limit: 10, collections: ['prices'] })).toEqual({
        head, changes: [{ seq: head, collection: 'prices', id: 'price1', op: 'delete' }], more: false,
      })
      expect(await service.changesSince({ since: head, limit: 10 })).toEqual({ head, changes: [], more: false })
      expect(await service.changesSince({ since: 0, limit: 10, collections: [] })).toEqual({ head, changes: [], more: false })
    })

    async function drain(cursor: { since: number; ids: string[] }) {
      for (let more = true; more;) {
        const page = await service.changesSince({ since: cursor.since, limit: 1000 })
        cursor.ids.push(...page.changes.map(change => change.id))
        cursor.since = page.changes.at(-1)?.seq ?? cursor.since
        more = page.more
      }
    }

    it('a cursor reader sees every row when a later writer starts while an earlier write is uncommitted', async () => {
      let release!: () => void
      const released = new Promise<void>(resolve => { release = resolve })
      let recorded!: () => void
      const aRecorded = new Promise<void>(resolve => { recorded = resolve })
      const a = MikroOrmWrapper.forkManager().transactional(async em => {
        await service.record([{ ...product, objectId: 'a' }], { manager: em })
        recorded()
        await released
      })
      await Promise.race([aRecorded, a])
      let bDone = false
      const b = service.record([{ ...product, objectId: 'b' }]).then(() => { bDone = true })
      const lockWaits = `select 1 from pg_locks where locktype = 'advisory' and not granted
        and database = (select oid from pg_database where datname = current_database())`
      // Bounded wait until B has either committed or is blocked on the journal lock.
      for (const deadline = Date.now() + 2000; !bDone && Date.now() < deadline && !(await sql(lockWaits)).length;) {
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      const cursor = { since: 0, ids: [] as string[] }
      await drain(cursor)
      release()
      await Promise.all([a, b])
      await drain(cursor)
      expect(cursor.ids).toEqual(['a', 'b'])
    })

    it('changesSince reads head before the rows, so a row committed during the head read is not lost', async () => {
      await service.record([{ ...product, objectId: 'before' }])
      const head = TallySyncModuleService.prototype.head
      const spy = jest.spyOn(TallySyncModuleService.prototype, 'head').mockImplementationOnce(
        async function (this: TallySyncModuleService, ...args: Parameters<typeof head>) {
          await service.record([{ ...product, objectId: 'between' }])
          return head.apply(this, args)
        })
      const page = await service.changesSince({ since: 0, limit: 10 })
      expect(spy).toHaveBeenCalledTimes(1)
      spy.mockRestore()
      expect(page.head).toBeGreaterThanOrEqual(page.changes.at(-1)!.seq)
      const next = await service.changesSince({ since: page.head, limit: 10 })
      expect([...page.changes, ...next.changes].map(change => change.id)).toEqual(expect.arrayContaining(['before', 'between']))
    })

    it('changesSince reports head as at least the last seq when its head read is older than a committed row', async () => {
      const staleHead = await service.head()
      await service.record([{ ...product, objectId: 'after-head' }])
      const [last] = await sql('select seq from tally_change order by seq desc limit 1')
      jest.spyOn(TallySyncModuleService.prototype, 'head').mockResolvedValueOnce(staleHead)
      const page = await service.changesSince({ since: 0, limit: 10 })
      jest.restoreAllMocks()
      expect(page.head).toBeGreaterThanOrEqual(Number(last.seq))
      expect(page.changes.map(change => change.id)).toContain('after-head')
    })

    it('record rejects with 55P03 when another connection holds the journal lock past the timeout', async () => {
      let release!: () => void
      const released = new Promise<void>(resolve => { release = resolve })
      let locked!: () => void
      const holding = new Promise<void>(resolve => { locked = resolve })
      const holder = MikroOrmWrapper.forkManager().transactional(async em => {
        await service.record([{ ...product, objectId: 'holder' }], { manager: em })
        locked()
        await released
      })
      await Promise.race([holding, holder])
      setJournalLockTimeoutForTests('200ms')
      try {
        await expect(service.record([{ ...product, objectId: 'blocked' }])).rejects.toMatchObject({ code: '55P03' })
      } finally {
        setJournalLockTimeoutForTests()
        release()
        await holder
      }
      expect((await sql('select object_id from tally_change')).map(row => row.object_id)).toEqual(['holder'])
    })

    it('recordEvent returns 0 and writes nothing for an event it does not resolve', async () => {
      expect(await service.recordEvent('product.product-type.updated', 'ptyp_1')).toBe(0)
      expect(await sql('select seq from tally_change')).toEqual([])
    })

    it('initialize creates an epoch and backfill once, and a second call adds nothing', async () => {
      expect(await service.getState()).toBeNull()
      const first = await service.initialize(['p1', 'p2'])
      expect(first).toEqual({ epoch: expect.any(String), created: true })
      expect(first.epoch).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      expect(await service.getState()).toEqual({ epoch: first.epoch, priceListWatermark: null, priceWindowRunAt: null })
      const rows = await sql('select collection, object_id, op from tally_change order by seq')
      expect(rows).toEqual([
        { collection: 'products', object_id: 'p1', op: 'upsert' },
        { collection: 'products', object_id: 'p2', op: 'upsert' },
      ])
      expect(await service.initialize(['p3'])).toEqual({ epoch: first.epoch, created: false })
      expect(await sql('select collection, object_id, op from tally_change order by seq')).toEqual(rows)
    })

    it('five concurrent initialize calls all resolve with one epoch and exactly one backfill', async () => {
      const lists = Array.from({ length: 5 }, (_, i) => [`p${i}a`, `p${i}b`])
      const calls = await Promise.allSettled(lists.map(ids => service.initialize(ids)))
      expect(calls.map(call => call.status)).toEqual(Array(5).fill('fulfilled'))
      const results = calls.map(call => (call as PromiseFulfilledResult<{ epoch: string; created: boolean }>).value)
      expect(new Set(results.map(result => result.epoch)).size).toBe(1)
      expect(results.filter(result => result.created)).toHaveLength(1)
      expect(await sql('select id, epoch from tally_sync_state')).toEqual([{ id: 'sync', epoch: results[0].epoch }])
      expect(await sql('select collection, object_id, op from tally_change order by seq')).toEqual(
        lists[results.findIndex(result => result.created)].map(object_id => ({ collection: 'products', object_id, op: 'upsert' })))
    })

    it('setPriceListWatermark is a no-op without state and round-trips both timestamps and null', async () => {
      const watermark = '2026-09-30T09:00:00.000Z'
      const runAt = '2026-09-30T09:01:00.000Z'
      await service.setPriceListWatermark(watermark, runAt)
      expect(await service.getState()).toBeNull()
      const { epoch } = await service.initialize([])
      await service.setPriceListWatermark(watermark, runAt)
      expect(await service.getState()).toEqual({ epoch, priceListWatermark: watermark, priceWindowRunAt: runAt })
      await service.setPriceListWatermark(null, null)
      expect(await service.getState()).toEqual({ epoch, priceListWatermark: null, priceWindowRunAt: null })
    })
  },
})
