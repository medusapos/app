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
      expect(state).toEqual({ epoch: first.data.epoch, priceListWatermark: expect.any(String), priceWindowRunAt: state!.priceListWatermark })
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
      expect(noEpoch.status).toBe(400)
      expect(noEpoch.data).toEqual({ message: 'epoch is required when since > 0' })
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
      const head = await settle()
      // Price-list edits emit no event, so only the watcher can journal these.
      await api.post(`/admin/price-lists/${listId}`, { title: 'Renamed sync sale' }, { headers })
      await api.post(`/admin/price-lists/${listId}`, { status: 'draft' }, { headers })
      // Unforced ticks run the watcher at most once per 5 s per process, so keep ticking until one does.
      await expectProductRow(head, () => get('/tally/v1/changes/tick'), 12000)
    })

    it('5. the price-list watcher journals the product once a scheduled list starts', async () => {
      await get('/tally/v1/changes')
      const createdAt = Date.now()
      await api.post('/admin/price-lists', {
        title: 'Scheduled sale', description: 'Starts soon', status: 'active', starts_at: new Date(createdAt + 3000).toISOString(),
        prices: [{ variant_id: data.variantA, currency_code: 'eur', amount: 7 }],
      }, { headers })
      await runPriceListWatcher(container, { force: true })
      const head = await settle()
      await sleep(Math.max(0, createdAt + 4000 - Date.now()))
      await runPriceListWatcher(container, { force: true })
      expect((await sync.changesSince({ since: head, limit: 1000 })).changes).toEqual(productUpsert())
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
