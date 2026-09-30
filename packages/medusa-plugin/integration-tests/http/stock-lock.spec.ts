import path from 'node:path'
import type { MedusaContainer } from '@medusajs/framework/types'
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import { InMemoryLockingProvider } from '@medusajs/locking/dist/providers/in-memory'
import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import tallyLockingCheck, { IN_MEMORY_LOCKING_WARNING } from '../../src/jobs/tally-locking-check'

jest.setTimeout(180000)
const START = 100
const SALES = 20
const ROUNDS = 5

medusaIntegrationTestRunner({
  cwd: path.resolve(__dirname, '../plugin-app'),
  testSuite: ({ getContainer }) => {
    let container: MedusaContainer
    let itemId: string
    let locationId: string

    beforeEach(async () => {
      container = getContainer()
      itemId = (await container.resolve(Modules.INVENTORY).createInventoryItems({ sku: 'RACE' })).id
      locationId = (await container.resolve(Modules.STOCK_LOCATION).createStockLocations({ name: 'Race' })).id
      await container.resolve(Modules.INVENTORY).createInventoryLevels({ inventory_item_id: itemId, location_id: locationId })
    })

    type Through = (sale: number, decrement: () => Promise<unknown>) => Promise<unknown>
    // Sets the level to START, then runs SALES concurrent decrements of 1, each through `through`, and returns the
    // final stocked quantity.
    async function sell(through: Through): Promise<number> {
      const inventory = container.resolve(Modules.INVENTORY)
      await inventory.updateInventoryLevels({ inventory_item_id: itemId, location_id: locationId, stocked_quantity: START })
      const decrement = () => inventory.adjustInventory(itemId, locationId, -1)
      await Promise.all(Array.from({ length: SALES }, (_, sale) => through(sale, decrement)))
      return Number((await inventory.retrieveInventoryLevelByItemAndLocation(itemId, locationId)).stocked_quantity)
    }
    const unlocked: Through = (_, decrement) => decrement()
    const locked = (locking: { execute: (key: string, job: () => Promise<unknown>) => Promise<unknown> }): Through =>
      (_, decrement) => locking.execute(itemId, decrement)

    // The extreme case, no shared lock at all: all SALES decrements run at once.
    it('loses stock updates when concurrent decrements are not serialised', async () => {
      const finals: number[] = []
      for (let round = 0; round < 5; round++) finals.push(await sell(unlocked))
      console.log(`unlocked: start ${START}, ${SALES} decrements, finals ${finals.join(', ')}`)
      for (const final of finals) expect(final).toBeGreaterThan(START - SALES)
    })

    // One process: the plugin's lock on the inventory item id serialises them (workflow.ts).
    it('loses nothing when the decrements go through one locking key', async () => {
      for (let round = 0; round < 5; round++) expect(await sell(locked(container.resolve(Modules.LOCKING)))).toBe(START - SALES)
    })

    // What two instances really do: each serialises its own sales through its own in-memory provider (the default,
    // built standalone here as each process would) on the item id, as workflow.ts does, so at most two decrements
    // overlap. The sales alternate between the instances.
    it('two instances, each with its own in-memory lock, lose stock updates', async () => {
      const instances = [locked(new InMemoryLockingProvider()), locked(new InMemoryLockingProvider())]
      const finals: number[] = []
      for (let round = 0; round < ROUNDS; round++) finals.push(await sell((sale, decrement) => instances[sale % 2](sale, decrement)))
      console.log(`two instances: start ${START}, ${SALES} decrements, finals ${finals.join(', ')}`)
      for (const final of finals) expect(final).toBeGreaterThan(START - SALES)
    })

    const logger = () => ({ warn: jest.fn(), debug: jest.fn() })
    const withOverrides = (overrides: Record<string, unknown>) => ({
      resolve: (key: string) => key in overrides ? overrides[key] : container.resolve(key),
    }) as unknown as MedusaContainer

    it('warns once when the default in-memory locking provider is active', async () => {
      const stub = logger()
      await tallyLockingCheck(withOverrides({ [ContainerRegistrationKeys.LOGGER]: stub }))
      expect(stub.warn).toHaveBeenCalledTimes(1)
      expect(stub.warn).toHaveBeenCalledWith(IN_MEMORY_LOCKING_WARNING)
    })

    it('stays quiet with another locking provider', async () => {
      const stub = logger()
      await tallyLockingCheck(withOverrides({ [ContainerRegistrationKeys.LOGGER]: stub,
        [Modules.LOCKING]: { defaultProviderId: 'locking-redis' } }))
      expect(stub.warn).not.toHaveBeenCalled()
    })

    it('logs at debug and carries on when detection throws', async () => {
      const stub = logger()
      await tallyLockingCheck({ resolve: (key: string) => {
        if (key === Modules.LOCKING) throw new Error('no locking module')
        return stub
      } } as unknown as MedusaContainer)
      expect(stub.warn).not.toHaveBeenCalled()
      expect(stub.debug).toHaveBeenCalledWith(expect.stringContaining('no locking module'))
    })
  },
})
