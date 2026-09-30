import path from 'node:path'
import type { MedusaContainer } from '@medusajs/framework/types'
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import tallyLockingCheck, { IN_MEMORY_LOCKING_WARNING } from '../../src/jobs/tally-locking-check'

jest.setTimeout(180000)
const START = 100
const SALES = 20

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

    // Sets the level to START, then runs SALES concurrent decrements of 1 and returns the final stocked quantity.
    async function sell(lock: boolean): Promise<number> {
      const inventory = container.resolve(Modules.INVENTORY)
      await inventory.updateInventoryLevels({ inventory_item_id: itemId, location_id: locationId, stocked_quantity: START })
      const decrement = () => inventory.adjustInventory(itemId, locationId, -1)
      const locking = container.resolve(Modules.LOCKING)
      await Promise.all(Array.from({ length: SALES }, () => lock ? locking.execute(itemId, decrement) : decrement()))
      return Number((await inventory.retrieveInventoryLevelByItemAndLocation(itemId, locationId)).stocked_quantity)
    }

    // Two instances each hold their own in-memory lock, so across processes the decrements run unlocked.
    it('loses stock updates when concurrent decrements are not serialised', async () => {
      const finals: number[] = []
      for (let round = 0; round < 5; round++) finals.push(await sell(false))
      console.log(`unlocked: start ${START}, ${SALES} decrements, finals ${finals.join(', ')}`)
      for (const final of finals) expect(final).toBeGreaterThan(START - SALES)
    })

    // One process: the plugin's lock on the inventory item id serialises them (workflow.ts).
    it('loses nothing when the decrements go through one locking key', async () => {
      for (let round = 0; round < 5; round++) expect(await sell(true)).toBe(START - SALES)
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
