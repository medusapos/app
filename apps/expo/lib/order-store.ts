import { addRxPlugin, createRxDatabase, removeRxDatabase, type RxCollection, type RxDatabase, type RxStorage } from 'rxdb';
import { wrappedValidateAjvStorage } from 'rxdb/plugins/validate-ajv';
import { getRxStorageDexie } from 'rxdb/plugins/storage-dexie';
import { RxDBLocalDocumentsPlugin } from 'rxdb/plugins/local-documents';
import { withStorageWatchdog } from '@tallyui/database';
import { addPosOrderCollection, posOrderCollection, posOrderSchema, type PosOrder } from '@tallyui/pos';
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

// E2E debug only (guarded below, folded away in production): sessionStorage, so it survives the
// reload `e2e/storage.spec.ts` uses to reach a fresh openOrderStore, unlike an in-memory flag.
const E2E_FAIL_NEXT_OPEN_KEY = 'medusapos-e2e-fail-next-order-store-open';

// Local document id recording that `carryOverOrders` copied a legacy database (count and time).
// A record only: it never causes a delete, nor skips reading a legacy database that exists.
const LEGACY_ORDERS_MARKER = 'legacy-orders-migrated';

// How long an open waits on the previous store for its backend to close (#85 review). RxDB's close waits, with no
// time limit, for every write in flight, and a hung save's insert may never finish. Past this, the open fails with an
// ordinary Error, so the outbox's onOpenError shows #80's blocking prompt before the next sale takes any money.
export const ORDER_STORE_CLOSE_WAIT_MS = 10_000;

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
      // Migrates legacy v0 (or v1) to v2 in place; a DM4 throws here, before any copy or marker, so the source stays.
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
    // A rejected close still frees the name for a fresh database; the caller that awaited
    // close() itself already sees the rejection on its own reference to that promise.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stuck = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(
      new Error('The previous order store for this backend is still closing')), ORDER_STORE_CLOSE_WAIT_MS); });
    try {
      await Promise.race([entry.closing.catch(() => undefined), stuck]);
    } finally { clearTimeout(timer); }
    return openOrderStore(baseUrl);
  }
  if (!entry) {
    const opening = (async () => {
      if (process.env.EXPO_PUBLIC_E2E_DEBUG === '1' && typeof window !== 'undefined' && window.sessionStorage.getItem(E2E_FAIL_NEXT_OPEN_KEY)) {
        const code = window.sessionStorage.getItem(E2E_FAIL_NEXT_OPEN_KEY) as string;
        window.sessionStorage.removeItem(E2E_FAIL_NEXT_OPEN_KEY);
        throw Object.assign(new Error(`E2E FailNextOrderStoreOpen: ${code}`), { code });
      }
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
        // Migrates v0 or v1 to v2, all of it. A DM4 fails this open, never deletes: the older orders stay; the next open retries.
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
        shared.closing = store.close().finally(() => {
          // A store opened for this name after closeOrderStores() ran is a
          // different entry: never delete it under a late close() like this one.
          // Runs on a rejection too, so a failed close still frees the name.
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
    try {
      await entry.closing;
    } finally {
      // Runs on a rejection too, so a failed close still frees the name for the next open.
      if (stores.get(name) === entry) stores.delete(name);
    }
  }));
}

// E2E debug hooks (see e2e-debug.ts): each seeds one order into a store at an older `pos_orders` schema, exactly
// as the shipped builds wrote it, and resolves to that version. Faithful schemas, like TallyUI's open.test-helper:
// v1 is the current v2 minus its only additions (`lateSessionId`, `display`, `taxByRate`; TallyUI c1a), and
// v0 is v1 minus its only addition (`sessionId`; TallyUI #123).
// - SeedLegacyOrder: v0 into a backend's legacy Dexie order database (the pre-SQLite builds were all v0);
// - SeedV0Order / SeedV1Order: v0 / v1 into its SQLite order store, then end the worker;
// - FailNextOrderStoreOpen: arms the check above so the next openOrderStore rejects once with `code`.
if (process.env.EXPO_PUBLIC_E2E_DEBUG === '1' && typeof window !== 'undefined') {
  const { lateSessionId: _late, display: _display, taxByRate: _taxByRate, ...v1Properties } = posOrderSchema.properties;
  const { sessionId: _session, ...v0Properties } = v1Properties;
  const olderSchemas = {
    0: { ...posOrderSchema, version: 0, properties: v0Properties as typeof posOrderSchema.properties },
    1: { ...posOrderSchema, version: 1, properties: v1Properties as typeof posOrderSchema.properties },
  };
  const seed = async (version: 0 | 1, name: string, storage: RxStorage<any, any>, order: PosOrder) => {
    const db = await createRxDatabase<{ pos_orders: RxCollection<PosOrder> }>({ name, storage, multiInstance: false });
    try {
      // Version 1 shipped with its identity strategy; posOrderCollection() loads the migration plugin it needs.
      posOrderCollection();
      await db.addCollections({ pos_orders: version === 0 ? { schema: olderSchemas[0] }
        : { schema: olderSchemas[1], migrationStrategies: { 1: (doc: PosOrder) => doc } } });
      await db.pos_orders.insert(order);
      return db.pos_orders.schema.version;
    } finally { await db.close(); }
  };
  exposeE2eHook('SeedLegacyOrder', (baseUrl: string, order: PosOrder) =>
    seed(0, legacyDexieName('orders', baseUrl), getRxStorageDexie(), order));
  exposeE2eHook('SeedV0Order', (baseUrl: string, order: PosOrder) =>
    seed(0, orderDatabaseName(baseUrl), productCacheStorage(), order).finally(terminateWebStorage));
  exposeE2eHook('SeedV1Order', (baseUrl: string, order: PosOrder) =>
    seed(1, orderDatabaseName(baseUrl), productCacheStorage(), order).finally(terminateWebStorage));
  exposeE2eHook('FailNextOrderStoreOpen', (code: string) => window.sessionStorage.setItem(E2E_FAIL_NEXT_OPEN_KEY, code));
}
