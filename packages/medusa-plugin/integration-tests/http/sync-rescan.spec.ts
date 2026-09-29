import path from 'node:path'
import type { MedusaContainer } from '@medusajs/framework/types'
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import { TALLY_SYNC_MODULE } from '../../src/modules/tally-sync'
import type TallySyncModuleService from '../../src/modules/tally-sync/service'
import { ensureInitialized } from '../../src/modules/tally-sync/sync-state'
import { seed } from './seed'

jest.setTimeout(180000)
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

medusaIntegrationTestRunner({
  cwd: path.resolve(__dirname, '../plugin-app'),
  testSuite: ({ getContainer }) => {
    let container: MedusaContainer
    let sync: TallySyncModuleService
    let data: Awaited<ReturnType<typeof seed>>
    let productId: string
    let untouchedId: string

    beforeEach(async () => {
      container = getContainer()
      sync = container.resolve(TALLY_SYNC_MODULE)
      data = await seed(container)
      const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
      productId = (await knex('product_variant').where('id', data.variantA).first()).product_id
      // A second live product the direct writes never touch, so an over-broad rescan would journal it too.
      untouchedId = (await container.resolve(Modules.PRODUCT).createProducts({ title: 'Untouched product' })).id
    })

    // Subscribers journal asynchronously; wait until the head has not moved for a second.
    async function settle(): Promise<number> {
      let head = await sync.head()
      for (let stableSince = Date.now(), deadline = stableSince + 10000; Date.now() - stableSince < 1000 && Date.now() < deadline;) {
        await sleep(100)
        const next = await sync.head()
        if (next !== head) [head, stableSince] = [next, Date.now()]
      }
      return head
    }

    // Initializes the journal, lets queued events land, then makes a write no subscriber sees; returns the head
    // before it and the database's now() from just before it, for an explicit rescan since.
    async function directWrite(table: string, id: string, values: Record<string, unknown>): Promise<{ head: number; since: string }> {
      await ensureInitialized(container)
      const head = await settle()
      const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
      const since = (await knex.raw('select now()::text as now')).rows[0].now as string
      await knex(table).where('id', id).update({ ...values, updated_at: knex.raw('now()') })
      return { head, since }
    }

    async function priceId(): Promise<string> {
      const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
      return (await knex('price').join('product_variant_price_set as link', 'link.price_set_id', 'price.price_set_id')
        .where('link.variant_id', data.variantA).select('price.id').first()).id
    }

    it('1. a direct variant write is journaled as an upsert for its product, and nothing else', async () => {
      const { head, since } = await directWrite('product_variant', data.variantA, { title: 'Direct A' })
      await expect(sync.rescan(since)).resolves.toEqual({ since: expect.any(String), rows: 1 })
      expect((await sync.changesSince({ since: head, limit: 100 })).changes).toEqual([
        expect.objectContaining({ collection: 'products', id: productId, op: 'upsert' })])
    })

    it('2. a direct soft delete of a product is journaled as a delete', async () => {
      const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
      const { head, since } = await directWrite('product', productId, { deleted_at: knex.raw('now()') })
      await expect(sync.rescan(since)).resolves.toEqual({ since: expect.any(String), rows: 1 })
      expect((await sync.changesSince({ since: head, limit: 100 })).changes).toEqual([
        expect.objectContaining({ collection: 'products', id: productId, op: 'delete' })])
    })

    it('3. rescan returns null before the journal is initialized', async () => {
      await expect(sync.rescan(new Date().toISOString())).resolves.toBeNull()
    })

    it('4. an explicit since in the future journals nothing', async () => {
      const { head } = await directWrite('product_variant', data.variantA, { title: 'Direct A' })
      const result = await sync.rescan(new Date(Date.now() + 3600000).toISOString())
      expect(result).toEqual({ since: expect.any(String), rows: 0 })
      expect(await sync.head()).toBe(head)
    })

    it('5. a direct price-only write is journaled as an upsert for its product', async () => {
      const { head, since } = await directWrite('price', await priceId(), { amount: 77 })
      await expect(sync.rescan(since)).resolves.toEqual({ since: expect.any(String), rows: 1 })
      expect((await sync.changesSince({ since: head, limit: 100 })).changes).toEqual([
        expect.objectContaining({ collection: 'products', id: productId, op: 'upsert' })])
    })

    it('6. a later journal row for a different product does not stop the rescan from journaling an earlier direct write', async () => {
      const { head, since } = await directWrite('product_variant', data.variantA, { title: 'Direct A' })
      await container.resolve(Modules.PRODUCT).updateProducts(untouchedId, { title: 'Untouched updated' })
      await settle()
      expect((await sync.rescan(since))?.rows).toBeGreaterThanOrEqual(1)
      expect((await sync.changesSince({ since: head, limit: 100 })).changes).toEqual(
        expect.arrayContaining([expect.objectContaining({ collection: 'products', id: productId, op: 'upsert' })]))
    })
  },
})
