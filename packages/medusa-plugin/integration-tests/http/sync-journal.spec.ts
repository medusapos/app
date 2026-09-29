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
    })
    afterEach(() => jest.restoreAllMocks())

    async function expectChanges(since: number, productIds: string[], op: 'upsert' | 'delete' = 'upsert') {
      const expected = productIds.map(id => expect.objectContaining({ collection: 'products', id, op }))
      const deadline = Date.now() + 5000
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

    it('6. journals a delete after an admin product delete', async () => {
      const headBefore = await sync.head()
      await api.delete(`/admin/products/${productId}`, { headers })
      await expectChanges(headBefore, [productId], 'delete')
    })

    it('7. journals every linked product when an option value is added', async () => {
      const headBefore = await sync.head()
      await api.post(`/admin/product-options/${optionId}`, { values: ['A', 'B', 'C', 'D', 'E'] }, { headers })
      await expectChanges(headBefore, [productId, secondProductId])
    })

    it('8. flag off: a product update adds no journal row within two seconds', async () => {
      const ledger = container.resolve<TallyLedgerModuleService>(TALLY_LEDGER_MODULE)
      jest.spyOn(ledger, 'getPluginOptions').mockReturnValue({})
      const headBefore = await sync.head()
      await api.post(`/admin/products/${productId}`, { title: 'Flag off update' }, { headers })
      const deadline = Date.now() + 2000
      do {
        const page = await sync.changesSince({ since: headBefore, limit: 100 })
        expect(page.changes).toEqual([])
        await new Promise(resolve => setTimeout(resolve, 100))
      } while (Date.now() < deadline)
    })
  },
})
