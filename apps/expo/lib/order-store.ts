import { addRxPlugin, createRxDatabase, removeRxDatabase, type RxCollection, type RxDatabase, type RxStorage } from 'rxdb';
import { wrappedValidateAjvStorage } from 'rxdb/plugins/validate-ajv';
import { getRxStorageDexie } from 'rxdb/plugins/storage-dexie';
import { RxDBLocalDocumentsPlugin } from 'rxdb/plugins/local-documents';
import { posOrderSchema, type PosOrder } from '@tallyui/pos';
import { legacyDexieName, productCacheName, productCacheStorage } from './product-cache';
import { webStorageAvailable } from './web-storage';

addRxPlugin(RxDBLocalDocumentsPlugin);

type OrdersDatabase = RxDatabase<{ pos_orders: RxCollection<PosOrder> }>;
type OrderStore = { orders: RxCollection<PosOrder>; close(): Promise<void> };
const stores = new Map<string, { opening: Promise<OrderStore>; users: number; closing?: Promise<void> }>();

// Local document id marking that `carryOverOrders` already ran (successfully, or found
// nothing to copy) for a store, so a later open never repeats or duplicates the copy.
const LEGACY_ORDERS_MARKER = 'legacy-orders-migrated';

export function orderDatabaseName(baseUrl: string): string {
  return productCacheName('orders', baseUrl);
}

/**
 * `removeRxDatabase`, then a broad IndexedDB sweep for any `rxdb-dexie-<fromName>--` database it
 * left behind: the local-documents plugin's removal hook creates, then immediately removes, its
 * own "plugin-local-documents" Dexie database as part of that call, even for a database that
 * never used local documents — and in a real browser, that round trip can itself leave the
 * (still-empty) database behind. Never throws.
 */
async function removeLegacyOrdersDatabase(fromName: string, fromStorage: RxStorage<any, any>): Promise<void> {
  await removeRxDatabase(fromName, fromStorage);
  const databases = await globalThis.indexedDB?.databases?.().catch(() => undefined);
  if (!databases) return;
  const prefix = `rxdb-dexie-${fromName}--`;
  const names = databases.map((db) => db.name).filter((name): name is string => !!name?.startsWith(prefix));
  await Promise.all(names.map((name) => new Promise<void>((resolve) => {
    const request = globalThis.indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  })));
}

/**
 * One-time, idempotent, crash-safe copy of any sales left in the pre-SQLite
 * Dexie order store into the new one. Exported (rather than inlined in
 * `openOrderStore`) so a unit test can run it directly with memory storages.
 *
 * If the new database already carries the marker, only a leftover legacy
 * database is removed. Otherwise every `pos_orders` document is read from
 * the legacy database and upserted into the new one by id (so a repeat
 * after a crash below never duplicates a sale, keeping each document's own
 * `syncStatus`), verified present by a `findByIds` count, and only then is
 * the marker written; only after the marker is committed is the legacy
 * database removed. A failure anywhere before the marker is written leaves
 * the legacy database in place and only logs a warning: the store still
 * opens, and the next open repeats the copy.
 */
export async function carryOverOrders({ fromStorage, fromName, to }: {
  fromStorage: RxStorage<any, any>;
  fromName: string;
  to: OrdersDatabase;
}): Promise<void> {
  try {
    if (await to.getLocal(LEGACY_ORDERS_MARKER)) {
      await removeLegacyOrdersDatabase(fromName, fromStorage);
      return;
    }
    let count = 0;
    const legacy = await createRxDatabase<{ pos_orders: RxCollection<PosOrder> }>({
      name: fromName, storage: fromStorage, multiInstance: false,
    });
    try {
      await legacy.addCollections({ pos_orders: { schema: posOrderSchema } });
      const docs = (await legacy.pos_orders.find().exec()).map((doc) => doc.toJSON() as PosOrder);
      if (docs.length) {
        await to.pos_orders.bulkUpsert(docs);
        const found = await to.pos_orders.findByIds(docs.map((order) => order.id)).exec();
        if (found.size !== docs.length) {
          throw new Error(`carryOverOrders: only ${found.size} of ${docs.length} legacy orders verified in the new store`);
        }
        count = docs.length;
      }
    } finally {
      await legacy.close();
    }
    await to.insertLocal(LEGACY_ORDERS_MARKER, { count, at: new Date().toISOString() });
    await removeLegacyOrdersDatabase(fromName, fromStorage);
  } catch (error) {
    console.warn('Order carry-over from the legacy store failed; the next open will retry it:', error);
  }
}

export async function openOrderStore(baseUrl: string): Promise<OrderStore> {
  const name = orderDatabaseName(baseUrl);
  let entry = stores.get(name);
  if (entry?.closing) {
    await entry.closing;
    return openOrderStore(baseUrl);
  }
  if (!entry) {
    const opening = (async () => {
      const storage = productCacheStorage();
      const db = await createRxDatabase<{ pos_orders: RxCollection<PosOrder> }>({
        name, multiInstance: false, localDocuments: true,
        storage: process.env.NODE_ENV !== 'production' ? wrappedValidateAjvStorage({ storage }) : storage,
      });
      try {
        await db.addCollections({ pos_orders: { schema: posOrderSchema } });
        if (webStorageAvailable()) {
          await carryOverOrders({
            fromStorage: getRxStorageDexie(), fromName: legacyDexieName('orders', baseUrl), to: db,
          });
        }
        return { orders: db.pos_orders, close: async () => { await db.close(); } };
      } catch (error) { await db.close(); throw error; }
    })();
    entry = { opening, users: 0 };
    stores.set(name, entry);
    void opening.catch(() => { stores.delete(name); });
  }
  const shared = entry;
  shared.users++;
  const store = await shared.opening;
  let closed = false;
  return { orders: store.orders, async close() {
    if (closed) return;
    closed = true;
    if (--shared.users === 0) {
      // closeOrderStores() may already be closing this same entry; share that
      // promise instead of closing the database a second time.
      if (!shared.closing) {
        shared.closing = store.close().then(() => {
          // A store opened for this name after closeOrderStores() ran is a
          // different entry: never delete it under a late close() like this one.
          if (stores.get(name) === shared) stores.delete(name);
        });
      }
      await shared.closing;
    }
  } };
}

/**
 * Closes every open or still-opening store and removes it, so the next
 * `openOrderStore` for that name opens a fresh database. A store still
 * opening is closed once its open settles; a failed open counts as closed
 * (it already closed its own database). A later `close()` from a handle
 * handed out before this ran shares the same close and never touches a
 * store opened for that name afterwards.
 */
export async function closeOrderStores(): Promise<void> {
  await Promise.all([...stores.entries()].map(async ([name, entry]) => {
    if (!entry.closing) {
      entry.closing = entry.opening.then((store) => store.close(), () => undefined);
    }
    await entry.closing;
    if (stores.get(name) === entry) stores.delete(name);
  }));
}

export function needsAttention(orders: PosOrder[]): PosOrder[] {
  return orders.filter((order) => order.syncStatus === 'rejected'
    || (order.syncStatus === 'applied' && !!order.warnings?.length))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// E2E debug hook (same pattern as `__medusaposCatalogue` in use-replicated-products.ts):
// seeds one order into a backend's legacy Dexie order database, so live-tab.spec.ts and
// storage.spec.ts can plant a pending sale on the login page, before the store opens.
if (process.env.EXPO_PUBLIC_E2E_DEBUG === '1' && typeof window !== 'undefined') {
  (window as Window & { __medusaposSeedLegacyOrder?: (baseUrl: string, order: PosOrder) => Promise<void> })
    .__medusaposSeedLegacyOrder = async (baseUrl: string, order: PosOrder) => {
      const legacy = await createRxDatabase<{ pos_orders: RxCollection<PosOrder> }>({
        name: legacyDexieName('orders', baseUrl), storage: getRxStorageDexie(), multiInstance: false,
      });
      try {
        await legacy.addCollections({ pos_orders: { schema: posOrderSchema } });
        await legacy.pos_orders.insert(order);
      } finally {
        await legacy.close();
      }
    };
}
