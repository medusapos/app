import path from 'node:path'
import type { Logger, MedusaContainer } from '@medusajs/framework/types'
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import tallySyncRescan from '../../src/scripts/tally-sync-rescan'
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

    it('6. a direct inventory-level write is journaled as an upsert for its product', async () => {
      const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
      const levelId = (await knex('inventory_level').where('inventory_item_id', data.inventoryA).select('id').first()).id
      const { head, since } = await directWrite('inventory_level', levelId, { stocked_quantity: 42 })
      await expect(sync.rescan(since)).resolves.toEqual({ since: expect.any(String), rows: 1 })
      expect((await sync.changesSince({ since: head, limit: 100 })).changes).toEqual([
        expect.objectContaining({ collection: 'products', id: productId, op: 'upsert' })])
    })

    it('7. a direct option-value write is journaled as an upsert for its product', async () => {
      const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
      const valueId = (await knex('product_option_value as value')
        .join('product_product_option as pivot', 'pivot.product_option_id', 'value.option_id')
        .where('pivot.product_id', productId).select('value.id').first()).id
      const { head, since } = await directWrite('product_option_value', valueId, { value: 'A2' })
      await expect(sync.rescan(since)).resolves.toEqual({ since: expect.any(String), rows: 1 })
      expect((await sync.changesSince({ since: head, limit: 100 })).changes).toEqual([
        expect.objectContaining({ collection: 'products', id: productId, op: 'upsert' })])
    })

    it('8. a direct sales-channel link write is journaled as an upsert for its product', async () => {
      const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
      const linkId = (await knex('product_sales_channel').where('product_id', productId).select('id').first()).id
      const { head, since } = await directWrite('product_sales_channel', linkId, {})
      await expect(sync.rescan(since)).resolves.toEqual({ since: expect.any(String), rows: 1 })
      expect((await sync.changesSince({ since: head, limit: 100 })).changes).toEqual([
        expect.objectContaining({ collection: 'products', id: productId, op: 'upsert' })])
    })

    it('9. a direct inventory-item write is journaled as an upsert for its product', async () => {
      const { head, since } = await directWrite('inventory_item', data.inventoryA, { title: 'Direct inventory item' })
      await expect(sync.rescan(since)).resolves.toEqual({ since: expect.any(String), rows: 1 })
      expect((await sync.changesSince({ since: head, limit: 100 })).changes).toEqual([
        expect.objectContaining({ collection: 'products', id: productId, op: 'upsert' })])
    })

    it('10. a direct price-set link write is journaled as an upsert for its product', async () => {
      const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
      const linkId = (await knex('product_variant_price_set').where('variant_id', data.variantA).select('id').first()).id
      const { head, since } = await directWrite('product_variant_price_set', linkId, {})
      await expect(sync.rescan(since)).resolves.toEqual({ since: expect.any(String), rows: 1 })
      expect((await sync.changesSince({ since: head, limit: 100 })).changes).toEqual([
        expect.objectContaining({ collection: 'products', id: productId, op: 'upsert' })])
    })

    it('11. a direct inventory-item link write is journaled as an upsert for its product', async () => {
      const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
      const linkId = (await knex('product_variant_inventory_item').where('variant_id', data.variantA).select('id').first()).id
      const { head, since } = await directWrite('product_variant_inventory_item', linkId, {})
      await expect(sync.rescan(since)).resolves.toEqual({ since: expect.any(String), rows: 1 })
      expect((await sync.changesSince({ since: head, limit: 100 })).changes).toEqual([
        expect.objectContaining({ collection: 'products', id: productId, op: 'upsert' })])
    })

    it('12. a direct product-option write is journaled as an upsert for every product linked through the pivot', async () => {
      const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
      const optionId = (await knex('product_product_option').where('product_id', productId).select('product_option_id').first()).product_option_id
      const { head, since } = await directWrite('product_option', optionId, { title: 'Variant 2' })
      await expect(sync.rescan(since)).resolves.toEqual({ since: expect.any(String), rows: 1 })
      expect((await sync.changesSince({ since: head, limit: 100 })).changes).toEqual([
        expect.objectContaining({ collection: 'products', id: productId, op: 'upsert' })])
    })

    it('13. a direct product-product-option pivot write is journaled as an upsert for its product', async () => {
      const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
      const pivotId = (await knex('product_product_option').where('product_id', productId).select('id').first()).id
      const { head, since } = await directWrite('product_product_option', pivotId, {})
      await expect(sync.rescan(since)).resolves.toEqual({ since: expect.any(String), rows: 1 })
      expect((await sync.changesSince({ since: head, limit: 100 })).changes).toEqual([
        expect.objectContaining({ collection: 'products', id: productId, op: 'upsert' })])
    })

    it('14. a direct product-product-option-value pivot write is journaled as an upsert for its product', async () => {
      const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
      const pivotId = (await knex('product_product_option_value as value')
        .join('product_product_option as option', 'option.id', 'value.product_product_option_id')
        .where('option.product_id', productId).select('value.id').first()).id
      const { head, since } = await directWrite('product_product_option_value', pivotId, {})
      await expect(sync.rescan(since)).resolves.toEqual({ since: expect.any(String), rows: 1 })
      expect((await sync.changesSince({ since: head, limit: 100 })).changes).toEqual([
        expect.objectContaining({ collection: 'products', id: productId, op: 'upsert' })])
    })

    describe('the rescan script', () => {
      const exitCodeBefore = process.exitCode

      afterEach(() => { process.exitCode = exitCodeBefore })

      it('15. a since without a timezone exits non-zero and logs the message', async () => {
        const error = jest.spyOn(container.resolve<Logger>(ContainerRegistrationKeys.LOGGER), 'error').mockImplementation(() => undefined)
        await tallySyncRescan({ container, args: ['2026-09-29T10:00:00'] })
        expect(process.exitCode).toBe(1)
        expect(error).toHaveBeenCalledWith(expect.stringContaining('since must include a timezone'))
        error.mockRestore()
      })

      it('16. a since with a timezone that fails to parse exits non-zero and logs the message', async () => {
        const error = jest.spyOn(container.resolve<Logger>(ContainerRegistrationKeys.LOGGER), 'error').mockImplementation(() => undefined)
        await tallySyncRescan({ container, args: ['2026-13-01T00:00:00Z'] })
        expect(process.exitCode).toBe(1)
        expect(error).toHaveBeenCalledWith(expect.stringContaining('since is not a valid timestamp: 2026-13-01T00:00:00Z'))
        error.mockRestore()
      })

      it('17. a missing since exits non-zero and logs the usage line', async () => {
        const error = jest.spyOn(container.resolve<Logger>(ContainerRegistrationKeys.LOGGER), 'error').mockImplementation(() => undefined)
        await tallySyncRescan({ container, args: [] })
        expect(process.exitCode).toBe(1)
        expect(error).toHaveBeenCalledWith(expect.stringContaining('usage: medusa exec'))
        error.mockRestore()
      })

      it('18. a valid since journals the product and leaves the exit code clean', async () => {
        const { head, since } = await directWrite('product_variant', data.variantA, { title: 'Direct via script' })
        // An operator types an ISO timestamp, not Postgres's own `now()::text` rendering (no colon in its offset).
        await tallySyncRescan({ container, args: [new Date(since).toISOString()] })
        expect((await sync.changesSince({ since: head, limit: 100 })).changes).toEqual([
          expect.objectContaining({ collection: 'products', id: productId, op: 'upsert' })])
        expect([undefined, 0]).toContain(process.exitCode)
      })

      it('19. a rescan that throws exits non-zero and logs the failure', async () => {
        const error = jest.spyOn(container.resolve<Logger>(ContainerRegistrationKeys.LOGGER), 'error').mockImplementation(() => undefined)
        jest.spyOn(sync, 'rescan').mockRejectedValue(new Error('boom'))
        await tallySyncRescan({ container, args: ['2026-09-29T10:00:00Z'] })
        expect(process.exitCode).toBe(1)
        expect(error).toHaveBeenCalledWith(expect.stringContaining('tally_sync rescan: failed:'))
        error.mockRestore()
        jest.restoreAllMocks()
      })
    })
  },
})
