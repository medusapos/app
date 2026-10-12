import { expect, it, vi } from 'vitest';
import { createRxDatabase, type RxCollection, type RxDatabase } from 'rxdb';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import { wrappedValidateAjvStorage } from 'rxdb/plugins/validate-ajv';
import { addPosOrderCollection, type PosOrder } from '@tallyui/pos';

const dexieModuleLoaded = vi.hoisted(() => vi.fn());
vi.mock('rxdb/plugins/storage-dexie', () => {
  dexieModuleLoaded();
  return { getRxStorageDexie: vi.fn() };
});

it('does not load the Dexie storage when the order store module is imported', async () => {
  await import('./order-store');
  expect(dexieModuleLoaded).not.toHaveBeenCalled();
});

it('calls a storage loader only once a legacy database exists', async () => {
  const { carryOverOrders } = await import('./order-store');
  const to = await createRxDatabase<{ pos_orders: RxCollection<PosOrder> }>({
    name: 'target-carry-lazy', storage: wrappedValidateAjvStorage({ storage: getRxStorageMemory() }),
    multiInstance: false, localDocuments: true,
  });
  try {
    await addPosOrderCollection(to as unknown as RxDatabase);
    const fromStorage = vi.fn(async () => getRxStorageMemory());
    await carryOverOrders({
      fromStorage, fromName: 'legacy-carry-lazy', to, legacyExists: async () => false,
    });
    expect(fromStorage).not.toHaveBeenCalled();
    expect(await to.getLocal('legacy-orders-migrated')).toBeNull();

    await carryOverOrders({
      fromStorage, fromName: 'legacy-carry-lazy', to, legacyExists: async () => true,
    });
    expect(fromStorage).toHaveBeenCalledTimes(1);
    expect((await to.getLocal('legacy-orders-migrated'))?.toJSON().data).toMatchObject({ count: 0 });
  } finally { await to.close(); }
});
