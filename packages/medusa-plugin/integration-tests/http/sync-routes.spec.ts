import path from 'node:path'
import type { MedusaContainer } from '@medusajs/framework/types'
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import { TALLY_LEDGER_MODULE } from '../../src/modules/tally-ledger'
import type TallyLedgerModuleService from '../../src/modules/tally-ledger/service'
import { TALLY_SYNC_MODULE } from '../../src/modules/tally-sync'
import type TallySyncModuleService from '../../src/modules/tally-sync/service'
import { runPriceListWatcher } from '../../src/modules/tally-sync/sync-state'
import { seed } from './seed'

jest.setTimeout(180000)
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

medusaIntegrationTestRunner({
  cwd: path.resolve(__dirname, '../plugin-app'),
  testSuite: ({ api, getContainer }) => {
    let container: MedusaContainer
    let sync: TallySyncModuleService
    let data: Awaited<ReturnType<typeof seed>>
    let headers: Record<string, string>
    let productId: string

    beforeEach(async () => {
      container = getContainer()
      sync = container.resolve(TALLY_SYNC_MODULE)
      data = await seed(container)
      const email = 'sync-routes-admin@example.com'
      const password = 'integration-test-password'
      const user = await container.resolve(Modules.USER).createUsers({ email })
      const auth = container.resolve(Modules.AUTH)
      const { authIdentity, error } = await auth.register('emailpass', { body: { email, password } })
      expect(error).toBeUndefined()
      await auth.updateAuthIdentities({ id: authIdentity!.id, app_metadata: { user_id: user.id } })
      const login = await api.post('/auth/user/emailpass', { email, password })
      headers = { Authorization: `Bearer ${login.data.token}` }
      const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
      productId = (await knex('product_variant').where('id', data.variantA).first()).product_id
    })
    afterEach(() => jest.restoreAllMocks())

    function get(url: string, withAuth = true) {
      return api.get(url, { headers: withAuth ? headers : {}, validateStatus: () => true })
    }

    // Subscribers journal asynchronously; wait until the head has not moved for a second.
    async function settle(): Promise<number> {
      let head = await sync.head()
      let stableSince = Date.now()
      const deadline = Date.now() + 10000
      while (Date.now() < deadline && Date.now() - stableSince < 1000) {
        await sleep(100)
        const next = await sync.head()
        if (next !== head) {
          head = next
          stableSince = Date.now()
        }
      }
      return head
    }

    const productUpsert = () => expect.arrayContaining([expect.objectContaining({ collection: 'products', id: productId, op: 'upsert' })])

    async function expectProductRow(since: number, poke: () => Promise<unknown>, ms = 10000) {
      const deadline = Date.now() + ms
      let page: Awaited<ReturnType<TallySyncModuleService['changesSince']>>
      do {
        await poke()
        page = await sync.changesSince({ since, limit: 1000 })
        if (page.changes.some(change => change.collection === 'products' && change.id === productId && change.op === 'upsert')) return
        await sleep(500)
      } while (Date.now() < deadline)
      expect(page.changes).toEqual(productUpsert())
    }

    it('1. the first GET /changes initializes the journal, and limit=1 pages to the end with since', async () => {
      const first = await get('/tally/v1/changes')
      expect(first.status).toBe(200)
      expect(first.data).toEqual(expect.objectContaining({ epoch: expect.any(String), horizon: 0, more: false }))
      expect(first.data.changes).toEqual(productUpsert())
      // initialize() with no ids read the products and set both watcher timestamps inside its transaction.
      const state = await sync.getState()
      expect(state).toEqual({ epoch: first.data.epoch, priceListWatermark: expect.any(String), priceWindowRunAt: expect.any(String) })
      // The watermark starts one lag behind priceWindowRunAt, the same as after a watcher run.
      const initialLagMs = new Date(state!.priceWindowRunAt!).getTime() - new Date(state!.priceListWatermark!).getTime()
      expect(initialLagMs).toBeGreaterThan(9000)
      expect(initialLagMs).toBeLessThan(11000)
      const head = await settle()
      const all = await get('/tally/v1/changes?limit=1000')
      expect(all.data).toEqual(expect.objectContaining({ epoch: first.data.epoch, head, more: false }))
      for (const change of all.data.changes) expect(change.revision).toBe(change.seq)

      const seqs: number[] = []
      let since = 0
      let page = await get(`/tally/v1/changes?limit=1&since=${since}&epoch=${first.data.epoch}`)
      expect(page.data.more).toBe(true)
      while (page.data.changes.length) {
        expect(page.status).toBe(200)
        seqs.push(...page.data.changes.map((change: { seq: number }) => change.seq))
        since = page.data.changes.at(-1).seq
        if (!page.data.more) break
        page = await get(`/tally/v1/changes?limit=1&since=${since}&epoch=${first.data.epoch}`)
      }
      expect(page.data.more).toBe(false)
      expect(seqs).toEqual(all.data.changes.map((change: { seq: number }) => change.seq))
      expect(since).toBe(head)
    })

    it('2. a wrong epoch or since beyond the head gets 410 cursor_expired, and bad parameters get 400', async () => {
      const { epoch } = (await get('/tally/v1/changes')).data
      const head = await settle()
      const wrongEpoch = await get('/tally/v1/changes?since=0&epoch=not-the-epoch')
      expect(wrongEpoch.status).toBe(410)
      expect(wrongEpoch.data).toEqual({ code: 'cursor_expired', epoch, head })
      const ahead = await get(`/tally/v1/changes?since=${head + 1}&epoch=${epoch}`)
      expect(ahead.status).toBe(410)
      expect(ahead.data).toEqual({ code: 'cursor_expired', epoch, head })
      for (const query of ['since=-1', 'since=x', 'limit=0', 'limit=1001']) {
        const bad = await get(`/tally/v1/changes?${query}`)
        expect(bad.status).toBe(400)
        expect(bad.data.message).toEqual(expect.any(String))
      }
      const noEpoch = await get('/tally/v1/changes?since=1')
      expect(noEpoch.status).toBe(410)
      expect(noEpoch.data).toEqual({ code: 'cursor_expired', epoch, head })
    })

    it('3. tick answers 304 at the head with the current epoch, and 200 with epoch, head and horizon otherwise', async () => {
      const { epoch } = (await get('/tally/v1/changes')).data
      const head = await settle()
      const current = await get(`/tally/v1/changes/tick?since=${head}&epoch=${epoch}`)
      expect(current.status).toBe(304)
      expect(current.data).toBe('')
      const stale = await get(`/tally/v1/changes/tick?since=0&epoch=${epoch}`)
      expect(stale.status).toBe(200)
      expect(stale.data).toEqual({ epoch, head, horizon: 0 })
      const bare = await get('/tally/v1/changes/tick')
      expect(bare.status).toBe(200)
      expect(bare.data).toEqual({ epoch, head, horizon: 0 })
    })

    const createList = (title: string) => api.post('/admin/price-lists', {
      title, description: 'Watcher test', status: 'active', prices: [{ variant_id: data.variantA, currency_code: 'eur', amount: 8 }],
    }, { headers }).then(created => created.data.price_list.id as string)

    it('4. an unforced tick runs the watcher, which journals the product after its list is retitled and set to draft', async () => {
      await get('/tally/v1/changes')
      const listId = await createList('Sync sale')
      await settle()
      const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
      // Push the list's updated_at outside the watermark's lag, so only the retitle's own updated_at can re-journal it.
      await knex('price_list').where('id', listId).update({ updated_at: knex.raw("now() - interval '1 hour'") })
      await runPriceListWatcher(container, { force: true })
      let head = await sync.head()
      // Price-list edits emit no event, so only the watcher can journal these.
      await api.post(`/admin/price-lists/${listId}`, { title: 'Renamed sync sale' }, { headers })
      // Unforced ticks run the watcher at most once per 5 s per process, so keep ticking until one does.
      await expectProductRow(head, () => get('/tally/v1/changes/tick'), 12000)

      await knex('price_list').where('id', listId).update({ updated_at: knex.raw("now() - interval '1 hour'") })
      await runPriceListWatcher(container, { force: true })
      head = await sync.head()
      await api.post(`/admin/price-lists/${listId}`, { status: 'draft' }, { headers })
      await expectProductRow(head, () => get('/tally/v1/changes/tick'), 12000)
    })

    it('4a. the watermark SQL: no match still advances it, a recent edit is caught on the next forced run too, and it never regresses', async () => {
      await get('/tally/v1/changes')
      const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
      const watermark = async () =>
        (await knex('tally_sync_state').where('id', 'sync').select('price_list_watermark').first()).price_list_watermark as Date

      // 1. No price list matches the window: the watermark still advances towards now() - lag.
      const beforeAnyList = await watermark()
      await runPriceListWatcher(container, { force: true })
      const afterNoMatch = await watermark()
      expect(afterNoMatch.getTime()).toBeGreaterThan(beforeAnyList.getTime())

      // 2. A list just edited is within the lag, so a forced run journals it, and the next forced run still does too.
      const listId = await createList('Watermark sale')
      await settle()
      // Backdate the edit a fixed 5 s, well inside the 10 s lag, so setup time cannot push it out before the second run.
      await knex('price_list').where('id', listId).update({ updated_at: knex.raw("now() - interval '5 seconds'") })
      let head = await sync.head()
      await runPriceListWatcher(container, { force: true })
      expect((await sync.changesSince({ since: head, limit: 1000 })).changes).toEqual(productUpsert())
      const beforeSecondMatch = await watermark()
      head = await sync.head()
      await runPriceListWatcher(container, { force: true })
      expect((await sync.changesSince({ since: head, limit: 1000 })).changes).toEqual(productUpsert())

      // 3. The watermark never moves backwards.
      const afterSecondMatch = await watermark()
      expect(afterSecondMatch.getTime()).toBeGreaterThanOrEqual(beforeSecondMatch.getTime())
    })

    it('5. the price-list watcher journals the product once a scheduled list starts', async () => {
      await get('/tally/v1/changes')
      // Setting starts_at through the admin route would also bump updated_at, and the watermark's lag would
      // journal the list on its own. Set it up with direct SQL instead, so only the window clause can fire.
      const listId = await createList('Scheduled sale')
      await settle()
      const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
      await knex('price_list').where('id', listId).update({
        updated_at: knex.raw("now() - interval '1 hour'"),
        starts_at: knex.raw("now() + interval '3 seconds'"),
      })
      await runPriceListWatcher(container, { force: true })
      const head = await sync.head()
      await runPriceListWatcher(container, { force: true })
      const unstarted = await sync.changesSince({ since: head, limit: 1000 })
      expect(unstarted.changes.some(change => change.collection === 'products' && change.id === productId)).toBe(false)
      const deadline = Date.now() + 10000
      let started = false
      while (!started && Date.now() < deadline) {
        const row = await knex('price_list').where('id', listId).select(knex.raw('(now() > starts_at) as started')).first()
        started = row.started
        if (!started) await sleep(250)
      }
      expect(started).toBe(true)
      // The list's updated_at is below the watermark, so only greatest() keeps the starts_at run from regressing it.
      const watermark = async () => (await sync.getState())!.priceListWatermark!
      const beforeStart = await watermark()
      await runPriceListWatcher(container, { force: true })
      expect((await sync.changesSince({ since: head, limit: 1000 })).changes).toEqual(productUpsert())
      expect(new Date(await watermark()).getTime()).toBeGreaterThanOrEqual(new Date(beforeStart).getTime())
    })

    it('6. flag off: both routes answer 404 and /info drops sync', async () => {
      expect((await get('/tally/v1/info')).data.contracts.sync).toEqual([1])
      const ledger = container.resolve<TallyLedgerModuleService>(TALLY_LEDGER_MODULE)
      jest.spyOn(ledger, 'getPluginOptions').mockReturnValue({})
      expect((await get('/tally/v1/changes')).status).toBe(404)
      expect((await get('/tally/v1/changes/tick')).status).toBe(404)
      const info = await get('/tally/v1/info')
      expect(info.status).toBe(200)
      expect(info.data.contracts).not.toHaveProperty('sync')
    })

    it('7. both routes answer 401 without a token', async () => {
      expect((await get('/tally/v1/changes', false)).status).toBe(401)
      expect((await get('/tally/v1/changes/tick', false)).status).toBe(401)
    })
  },
})
