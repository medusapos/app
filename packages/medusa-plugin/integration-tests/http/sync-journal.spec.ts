import path from 'node:path'
import type { MedusaContainer } from '@medusajs/framework/types'
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import { TALLY_LEDGER_MODULE } from '../../src/modules/tally-ledger'
import type TallyLedgerModuleService from '../../src/modules/tally-ledger/service'
import { TALLY_SYNC_MODULE } from '../../src/modules/tally-sync'
import type TallySyncModuleService from '../../src/modules/tally-sync/service'
import { seed } from './seed'

jest.setTimeout(180000)

medusaIntegrationTestRunner({
  cwd: path.resolve(__dirname, '../plugin-app'),
  testSuite: ({ api, getContainer }) => {
    let container: MedusaContainer
    let sync: TallySyncModuleService
    let data: Awaited<ReturnType<typeof seed>>
    let headers: Record<string, string>
    let productId: string
    let secondProductId: string
    let optionId: string
    let priceId: string
    let channelId: string

    beforeEach(async () => {
      container = getContainer()
      sync = container.resolve(TALLY_SYNC_MODULE)
      data = await seed(container)
      const email = 'sync-admin@example.com'
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
      optionId = (await knex('product_product_option').where('product_id', productId).first()).product_option_id
      priceId = (await knex('price').join('product_variant_price_set as link', 'link.price_set_id', 'price.price_set_id')
        .where('link.variant_id', data.variantA).select('price.id').first()).id
      await api.post(`/admin/product-options/${optionId}`, { is_exclusive: false }, { headers })
      const second = await api.post('/admin/products', {
        title: 'Shared option product', options: [{ id: optionId }],
      }, { headers })
      secondProductId = second.data.product.id
      const channel = await api.post('/admin/sales-channels', { name: 'Journal channel' }, { headers })
      channelId = channel.data.sales_channel.id
      await settleHead()
    })
    afterEach(() => jest.restoreAllMocks())

    // Waits until head has not changed for 1 s (at most 10 s), so earlier events cannot land in a later test's window.
    async function settleHead() {
      let head = await sync.head()
      for (let stableSince = Date.now(), deadline = stableSince + 10000; Date.now() - stableSince < 1000 && Date.now() < deadline;) {
        await new Promise(resolve => setTimeout(resolve, 100))
        const next = await sync.head()
        if (next !== head) [head, stableSince] = [next, Date.now()]
      }
    }

    async function expectChanges(since: number, productIds: string[], op: 'upsert' | 'delete' = 'upsert', ms = 5000) {
      const expected = productIds.map(id => expect.objectContaining({ collection: 'products', id, op }))
      const deadline = Date.now() + ms
      let page: Awaited<ReturnType<TallySyncModuleService['changesSince']>>
      do {
        page = await sync.changesSince({ since, limit: 100 })
        if (productIds.every(id => page.changes.some(change => change.collection === 'products' && change.id === id && change.op === op))) {
          expect(page.changes).toEqual(expect.arrayContaining(expected))
          return
        }
        await new Promise(resolve => setTimeout(resolve, 100))
      } while (Date.now() < deadline)
      expect(page!.changes).toEqual(expect.arrayContaining(expected))
    }

    it('1. journals an upsert after an admin product update', async () => {
      const headBefore = await sync.head()
      await api.post(`/admin/products/${productId}`, { title: 'Updated product' }, { headers })
      await expectChanges(headBefore, [productId])
    })

    it('2. journals an upsert after an admin variant price change', async () => {
      const headBefore = await sync.head()
      await api.post(`/admin/products/${productId}/variants/${data.variantA}`, {
        prices: [{ id: priceId, currency_code: 'eur', amount: 25 }],
      }, { headers })
      await expectChanges(headBefore, [productId])
    })

    it('3. journals an upsert after an inventory level change', async () => {
      const headBefore = await sync.head()
      await api.post(`/admin/inventory-items/${data.inventoryA}/location-levels/${data.berlinId}`, {
        stocked_quantity: 30,
      }, { headers })
      await expectChanges(headBefore, [productId])
    })

    it('4. journals upserts for sales channel add and remove, including the detached row', async () => {
      const headBefore = await sync.head()
      await api.post(`/admin/sales-channels/${channelId}/products`, { add: [productId] }, { headers })
      await expectChanges(headBefore, [productId])
      const headBeforeRemove = await sync.head()
      await api.post(`/admin/sales-channels/${channelId}/products`, { remove: [productId] }, { headers })
      await expectChanges(headBeforeRemove, [productId])
    })

    it('5. journals an upsert after a direct pricing module write', async () => {
      const headBefore = await sync.head()
      const pricing = container.resolve(Modules.PRICING)
      await (pricing as unknown as {
        updatePrices(data: { id: string; amount: number }): Promise<unknown>
      }).updatePrices({ id: priceId, amount: 42 })
      await expectChanges(headBefore, [productId])
    })

    async function latestOpAfterSettling(since: number, id: string): Promise<'upsert' | 'delete' | undefined> {
      const deadline = Date.now() + 5000
      let page = await sync.changesSince({ since, limit: 1000 })
      let stableSince = Date.now()
      let lastLength = page.changes.length
      while (Date.now() < deadline && Date.now() - stableSince < 1000) {
        await new Promise(resolve => setTimeout(resolve, 100))
        page = await sync.changesSince({ since, limit: 1000 })
        if (page.changes.length !== lastLength) {
          lastLength = page.changes.length
          stableSince = Date.now()
        }
      }
      return page.changes.filter(change => change.collection === 'products' && change.id === id).at(-1)?.op
    }

    it('6. journals a delete as the latest row after an admin product delete', async () => {
      const headBefore = await sync.head()
      await api.delete(`/admin/products/${productId}`, { headers })
      await expect(latestOpAfterSettling(headBefore, productId)).resolves.toBe('delete')
    })

    it('7. journals every linked product when an option value is added', async () => {
      const headBefore = await sync.head()
      await api.post(`/admin/product-options/${optionId}`, { values: ['A', 'B', 'C', 'D', 'E'] }, { headers })
      await expectChanges(headBefore, [productId, secondProductId])
    })

    it('8. flag off: a product update adds no journal row, and the next update with the flag on adds exactly one', async () => {
      const ledger = container.resolve<TallyLedgerModuleService>(TALLY_LEDGER_MODULE)
      const headBefore = await sync.head()
      const flag = jest.spyOn(ledger, 'getPluginOptions').mockReturnValue({})
      await api.post(`/admin/products/${productId}`, { title: 'Flag off update' }, { headers })
      // Keep the flag off until the subscriber has checked it and no further checks arrive for 500 ms (at most 5 s).
      for (let calls = 0, deadline = Date.now() + 5000; Date.now() < deadline && (!flag.mock.calls.length || flag.mock.calls.length !== calls);) {
        calls = flag.mock.calls.length
        await new Promise(resolve => setTimeout(resolve, 500))
      }
      expect(flag).toHaveBeenCalled()
      flag.mockRestore()
      await api.post(`/admin/products/${productId}`, { title: 'Flag on update' }, { headers })
      await expectChanges(headBefore, [productId])
      await settleHead()
      const page = await sync.changesSince({ since: headBefore, limit: 100 })
      expect(page.changes.filter(change => change.collection === 'products' && change.id === productId)).toHaveLength(1)
    })

    it('9. journals an upsert, not a delete, after deleting one variant of a multi-variant product', async () => {
      const headBefore = await sync.head()
      await api.delete(`/admin/products/${productId}/variants/${data.variantD}`, { headers })
      await expect(latestOpAfterSettling(headBefore, productId)).resolves.toBe('upsert')
    })

    it('10. journals an upsert after removing a variant price, which Medusa hard-deletes', async () => {
      const price = { id: priceId, currency_code: 'eur', amount: 10 }
      await api.post(`/admin/products/${productId}/variants/${data.variantA}`, {
        prices: [price, { currency_code: 'usd', amount: 12 }],
      }, { headers })
      await settleHead()
      const headBefore = await sync.head()
      await api.post(`/admin/products/${productId}/variants/${data.variantA}`, { prices: [price] }, { headers })
      await expectChanges(headBefore, [productId])
    })

    it('11. recordEvent writes nothing and returns 0 for a missing product, and 1 for an existing one', async () => {
      const headBefore = await sync.head()
      await expect(sync.recordEvent('product.product.deleted', 'prod_missing')).resolves.toBe(0)
      expect(await sync.head()).toBe(headBefore)
      await expect(sync.recordEvent('product.product.updated', productId)).resolves.toBe(1)
      expect((await sync.changesSince({ since: headBefore, limit: 10 })).changes).toEqual([
        expect.objectContaining({ collection: 'products', id: productId, op: 'upsert' })])
    })

    it('12. a 300-price burst holds one connection per process: admin stays responsive, and every affected product lands in the journal', async () => {
      const headBefore = await sync.head()
      const variantIds = [data.variantA, data.variantB, data.variantC, data.variantD]
      await api.post('/admin/price-lists', {
        title: 'G4 burst', description: 'G4 burst', status: 'active', type: 'sale',
        prices: Array.from({ length: 300 }, (_, index) => ({
          variant_id: variantIds[index % variantIds.length], min_quantity: index + 1, currency_code: 'eur', amount: 6,
        })),
      }, { headers })
      const start = Date.now()
      await api.get('/admin/products?limit=1', { headers })
      expect(Date.now() - start).toBeLessThan(5000)
      await expectChanges(headBefore, [productId], 'upsert', 60000)
    })
  },
})
