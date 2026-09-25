import { addRxPlugin, createRxDatabase, removeRxDatabase, type RxCollection, type RxDatabase, type RxStorage } from 'rxdb';
import { wrappedValidateAjvStorage } from 'rxdb/plugins/validate-ajv';
import { getRxStorageDexie } from 'rxdb/plugins/storage-dexie';
import { RxDBLocalDocumentsPlugin } from 'rxdb/plugins/local-documents';
import { withStorageWatchdog } from '@tallyui/database';
import { addPosOrderCollection, posOrderSchema, type PosOrder } from '@tallyui/pos';
import { legacyDexieName, productCacheName, productCacheStorage } from './product-cache';
import { terminateWebStorage, webStorageAvailable } from './web-storage';
import { STORAGE_WATCHDOG_OPTIONS, watchStorageHealth } from './storage-health';
import { exposeE2eHook } from './e2e-debug';

addRxPlugin(RxDBLocalDocumentsPlugin);

type OrdersDatabase = RxDatabase<{ pos_orders: RxCollection<PosOrder> }>;
type OrderStore = { orders: RxCollection<PosOrder>; close(): Promise<void> };
const stores = new Map<string, { opening: Promise<OrderStore>; users: number; closing?: Promise<void> }>();
// The one open path for pos_orders (ADR-032 amendment 2). It takes an untyped RxDatabase, which a
// typed one isn't assignable to (RxDB's exportJSON generic), hence the cast; types only.
const addOrders = (db: OrdersDatabase) => addPosOrderCollection(db as unknown as RxDatabase);

// Local document id recording that `carryOverOrders` copied a legacy database (count and time).
// A record only: it never causes a delete, nor skips reading a legacy database that exists.
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
 * True when IndexedDB holds any `rxdb-dexie-<fromName>--…` database. Where the browser cannot
 * list databases, true: an unknown legacy database is read (and only then removed), never skipped.
 */
async function legacyOrdersDatabaseExists(fromName: string): Promise<boolean> {
  if (!globalThis.indexedDB?.databases) return true;
  return (await globalThis.indexedDB.databases()).some((db) => !!db.name?.startsWith(`rxdb-dexie-${fromName}--`));
}

/**
 * Idempotent, crash-safe copy of any sales in the pre-SQLite Dexie order
 * store into the new one, on every open while a legacy database exists
 * (a tab still on the old build can write one after a first copy).
 * Exported so a unit test can run it directly with memory storages.
 *
 * When `legacyExists()` is false it opens and creates nothing. Otherwise
 * every `pos_orders` document is read from the legacy database, only the
 * ids missing from the new store are inserted (`bulkInsert`, never upsert:
 * a copy already there, possibly synced since, always wins), every legacy
 * id is verified present by a `findByIds` count, the marker is written if
 * absent, and only then is the legacy database removed. A failure anywhere
 * before the removal leaves the legacy database in place and only logs a
 * warning: the store still opens, and the next open repeats the copy.
 */
export async function carryOverOrders({ fromStorage, fromName, to, legacyExists }: {
  fromStorage: RxStorage<any, any>;
  fromName: string;
  to: OrdersDatabase;
  legacyExists: () => Promise<boolean>;
}): Promise<void> {
  try {
    if (!(await legacyExists())) return;
    let count = 0;
    const legacy = await createRxDatabase<{ pos_orders: RxCollection<PosOrder> }>({
      name: fromName, storage: fromStorage, multiInstance: false,
    });
    try {
      // Migrates legacy v0 in place; a DM4 throws here, before any copy or marker, so the source stays.
      await addOrders(legacy);
      const docs = (await legacy.pos_orders.find().exec()).map((doc) => doc.toJSON() as PosOrder);
      if (docs.length) {
        const present = await to.pos_orders.findByIds(docs.map((order) => order.id)).exec();
        const missing = docs.filter((order) => !present.has(order.id));
        if (missing.length) await to.pos_orders.bulkInsert(missing);
        const found = await to.pos_orders.findByIds(docs.map((order) => order.id)).exec();
        if (found.size !== docs.length) {
          throw new Error(`carryOverOrders: only ${found.size} of ${docs.length} legacy orders verified in the new store`);
        }
        count = docs.length;
      }
    } finally {
      await legacy.close();
    }
    if (!(await to.getLocal(LEGACY_ORDERS_MARKER))) {
      await to.insertLocal(LEGACY_ORDERS_MARKER, { count, at: new Date().toISOString() });
    }
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
      const baseStorage = productCacheStorage();
      const onWebStorage = webStorageAvailable();
      // ADR-061: order-store.ts opens directly with createRxDatabase (not createTallyDatabase),
      // so it wraps the watchdog itself, same as TallyUI's own create-db.ts.
      const watched = onWebStorage ? withStorageWatchdog(baseStorage, STORAGE_WATCHDOG_OPTIONS) : undefined;
      const storage = watched ?? baseStorage;
      const db = await createRxDatabase<{ pos_orders: RxCollection<PosOrder> }>({
        name, multiInstance: false, localDocuments: true,
        storage: process.env.NODE_ENV !== 'production' ? wrappedValidateAjvStorage({ storage }) : storage,
      });
      const unwatch = watched ? watchStorageHealth(watched.health$) : undefined;
      try {
        // Migrates v0 to v1, all of it. A DM4 fails this open, never deletes: the v0 orders stay; the next open retries.
        const orders = await addOrders(db);
        if (onWebStorage) {
          await carryOverOrders({
            fromStorage: getRxStorageDexie(), fromName: legacyDexieName('orders', baseUrl), to: db,
            legacyExists: () => legacyOrdersDatabaseExists(legacyDexieName('orders', baseUrl)),
          });
        }
        return { orders, close: async () => { unwatch?.(); await db.close(); } };
      } catch (error) { unwatch?.(); await db.close(); throw error; }
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

// E2E debug hooks (see e2e-debug.ts):
// seeds one order at schema v0 (v1 minus `sessionId`, as builds before TallyUI #123 wrote it) into a backend's legacy
// Dexie order database, or (…SeedV0Order, then ending the worker) its SQLite order store; resolves to the version.
if (process.env.EXPO_PUBLIC_E2E_DEBUG === '1' && typeof window !== 'undefined') {
  const { sessionId: _added, ...v0Properties } = posOrderSchema.properties;
  const v0Schema = { ...posOrderSchema, version: 0, properties: v0Properties as typeof posOrderSchema.properties };
  const seedV0 = async (name: string, storage: RxStorage<any, any>, order: PosOrder) => {
    const db = await createRxDatabase<{ pos_orders: RxCollection<PosOrder> }>({ name, storage, multiInstance: false });
    try {
      await db.addCollections({ pos_orders: { schema: v0Schema } });
      await db.pos_orders.insert(order);
      return db.pos_orders.schema.version;
    } finally { await db.close(); }
  };
  exposeE2eHook('SeedLegacyOrder', (baseUrl: string, order: PosOrder) =>
    seedV0(legacyDexieName('orders', baseUrl), getRxStorageDexie(), order));
  exposeE2eHook('SeedV0Order', (baseUrl: string, order: PosOrder) =>
    seedV0(orderDatabaseName(baseUrl), productCacheStorage(), order).finally(terminateWebStorage));
}
