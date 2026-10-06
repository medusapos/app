import {
  addRxPlugin, createRxDatabase, getAllCollectionDocuments, prepareQuery, type RxCollection, type RxDatabase, type RxStorage,
} from 'rxdb';
import { migrateDocumentData } from 'rxdb/plugins/migration-schema';
import { wrappedValidateAjvStorage } from 'rxdb/plugins/validate-ajv';
import { getRxStorageDexie } from 'rxdb/plugins/storage-dexie';
import { RxDBLocalDocumentsPlugin } from 'rxdb/plugins/local-documents';
import { withStorageWatchdog } from '@tallyui/database';
import {
  addPosOrderCollection, addRegisterSessionCollection, cashMovementSchema, closureSchema, ensureRegister, orderDraftSchema, posOrderCollection, posOrderSchema, registerCommandCollection,
  type CashMovementCollection, type ClosureCollection, type PosOrder, type RegisterCommandCollection, type RegisterSessionCollection,
} from '@tallyui/pos';
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
// E2E debug only: the hold HoldOrderInserts sets and ReleaseOrderInserts resolves (hooks below).
let e2eInsertHold: { promise: Promise<void>; release(): void; waiting: number } | undefined;
// E2E debug only: set by FailNextClosureInsert (hook below), cleared by the one closure insert it fails.
let e2eFailClosureInsert = false;

// Local document id recording that `carryOverOrders` copied a legacy database (count and time).
// Once present, the legacy database is kept and never read again.
const LEGACY_ORDERS_MARKER = 'legacy-orders-migrated';

// How long an open waits on the previous store for its backend to close (#85 review). RxDB's close waits, with no
// time limit, for every write in flight, and a hung save's insert may never finish. Past this, the open fails with an
// ordinary Error, so the outbox's onOpenError shows #80's blocking prompt before the next sale takes any money.
export const ORDER_STORE_CLOSE_WAIT_MS = 10_000;

/** TallyUI's register collections (ADR 0017), beside `pos_orders`; commands sync when the store advertises `register`. */
export type RegisterCollections = {
  sessions: RegisterSessionCollection; movements: CashMovementCollection; closures: ClosureCollection;
  commands: RegisterCommandCollection;
};

/** The register collections of the database `orders` belongs to, as `openOrderStore` adds them. */
export function registerCollections(orders: RxCollection<PosOrder>): RegisterCollections {
  const { register_sessions, cash_movements, closures, register_commands } = orders.database.collections as unknown as Record<string, RxCollection>;
  return { sessions: register_sessions as RegisterSessionCollection, movements: cash_movements as CashMovementCollection,
    closures: closures as ClosureCollection, commands: register_commands as RegisterCommandCollection };
}

export function draftsCollection(orders: RxCollection<PosOrder> | null): RxCollection | undefined {
  return orders?.database?.collections.drafts;
}

export function orderDatabaseName(baseUrl: string): string {
  return productCacheName('orders', baseUrl);
}

/**
 * True when IndexedDB holds any `rxdb-dexie-<fromName>--…` database. Where the browser cannot
 * list databases, true: an unknown legacy database is read until marked, then kept (see `carryOverOrders`).
 */
async function legacyOrdersDatabaseExists(fromName: string): Promise<boolean> {
  if (!globalThis.indexedDB?.databases) return true;
  return (await globalThis.indexedDB.databases()).some((db) => !!db.name?.startsWith(`rxdb-dexie-${fromName}--`));
}

/**
 * Every live `pos_orders` document of the legacy database, brought to the current version by the migration strategies
 * `to` was added with (`posOrderCollection()`'s, the ones the SQLite store's own migration runs). Read only: each stored
 * version is opened with the schema RxDB stored for it in the database's internal store, as RxDB's own
 * `removeCollectionStorages` opens it, never with the current one, whose optional `sessionId` index (v3) Dexie refuses
 * (DXE1). Pre-SQLite builds wrote v0; a v1 or v2 build's in-place migration that stopped short can leave v1 or v2 beside
 * it, and the copy at the higher version wins.
 */
async function readLegacyOrders(legacy: RxDatabase, to: RxCollection<PosOrder>): Promise<PosOrder[]> {
  const stored = (await getAllCollectionDocuments(legacy.internalStore)).map((meta) => meta.data)
    .filter((meta) => meta.name === 'pos_orders').sort((a, b) => b.schema.version - a.schema.version);
  const orders = new Map<string, PosOrder>();
  for (const { schema } of stored) {
    const instance = await legacy.storage.createStorageInstance<PosOrder>({
      databaseName: legacy.name, collectionName: 'pos_orders', schema, options: {}, multiInstance: false,
      databaseInstanceToken: legacy.token, devMode: false,
    });
    try {
      const { documents } = await instance.query(prepareQuery(schema, { selector: { _deleted: { $eq: false } }, sort: [{ id: 'asc' }], skip: 0 }));
      for (const doc of documents.filter((doc) => !orders.has(doc.id))) {
        const { _deleted, _meta, _rev, _attachments, ...order } = await migrateDocumentData(to, schema.version, doc);
        orders.set(doc.id, order as PosOrder);
      }
    } finally { await instance.close(); }
  }
  return [...orders.values()];
}

/**
 * Idempotent, crash-safe copy of any sales in the pre-SQLite Dexie order
 * store into the new one, on every open until the marker is written, then never again
 * (later legacy sales from tabs still on pre-SQLite builds are not carried over).
 * Exported so a unit test can run it directly with memory storages.
 *
 * When `legacyExists()` is false it opens and creates nothing. Otherwise
 * every `pos_orders` document is read from the legacy database and migrated
 * without writing to it (`readLegacyOrders`), only the
 * ids missing from the new store are inserted (`bulkInsert`, never upsert:
 * a copy already there, possibly synced since, always wins), every legacy
 * id is verified present by a `findByIds` count, the marker is written if
 * absent. The legacy database is kept (Front desk ruling, 2026-09-30); deletion awaits a later release. A failure
 * before the marker leaves it absent and only logs a
 * warning: the store still opens, and the next open repeats the copy.
 */
export async function carryOverOrders({ fromStorage, fromName, to, legacyExists }: {
  fromStorage: RxStorage<any, any>;
  fromName: string;
  to: OrdersDatabase;
  legacyExists: () => Promise<boolean>;
}): Promise<void> {
  try {
    if (await to.getLocal(LEGACY_ORDERS_MARKER)) return;
    if (!(await legacyExists())) return;
    let count = 0;
    const legacy = await createRxDatabase({ name: fromName, storage: fromStorage, multiInstance: false });
    try {
      const docs = await readLegacyOrders(legacy, to.pos_orders);
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
    // The code reaches #80's prompt ("Error code") and Report a problem, telling this apart from other open failures.
    const stuck = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Object.assign(
      new Error('The previous order store for this backend is still closing'), { code: 'ORDER_STORE_CLOSE_TIMEOUT' })),
    ORDER_STORE_CLOSE_WAIT_MS); });
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
        // E2E debug only (folded away in production): while HoldOrderInserts holds, an insert waits before its write.
        if (process.env.EXPO_PUBLIC_E2E_DEBUG === '1') {
          orders.preInsert(() => { if (!e2eInsertHold) return; e2eInsertHold.waiting++; return e2eInsertHold.promise; }, false);
        }
        if (onWebStorage) {
          await carryOverOrders({
            fromStorage: getRxStorageDexie(), fromName: legacyDexieName('orders', baseUrl), to: db,
            legacyExists: () => legacyOrdersDatabaseExists(legacyDexieName('orders', baseUrl)),
          });
        }
        // Other register collections need no migration; register_sessions opens through the migrating opener.
        const { closures } = await db.addCollections({
          cash_movements: { schema: cashMovementSchema }, closures: { schema: closureSchema },
          register_commands: registerCommandCollection(), drafts: { schema: orderDraftSchema },
        });
        const register_sessions = await addRegisterSessionCollection(db as unknown as RxDatabase);
        // E2E debug only (folded away in production): FailNextClosureInsert fails one closure write, leaving a
        // session closed with its closure unwritten, as a restart mid-close does (ADR 0018).
        if (process.env.EXPO_PUBLIC_E2E_DEBUG === '1') {
          closures.preInsert(() => {
            if (!e2eFailClosureInsert) return;
            e2eFailClosureInsert = false;
            throw new Error('E2E: the closure write failed');
          }, false);
        }
        await ensureRegister(register_sessions, 'web');
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
// v1 is the current v6 minus the additions of v2 to v6 (`lateSessionId`, `display`, `taxByRate`; the `sessionId`
// index and maxLength, `sentVersion`, `downgradedFrom`; `localWarnings`, `serverFailures`; the required `taxRounding`),
// and v0 is v1 minus its only addition (`sessionId`; TallyUI #123).
// - SeedLegacyOrder: v0 into a backend's legacy Dexie order database (the pre-SQLite builds were all v0);
// - SeedV0Order / SeedV1Order: v0 / v1 into its SQLite order store, then end the worker;
// - FailNextOrderStoreOpen: arms the check above so the next openOrderStore rejects once with `code`.
if (process.env.EXPO_PUBLIC_E2E_DEBUG === '1' && typeof window !== 'undefined') {
  const { lateSessionId: _late, display: _display, taxByRate: _taxByRate, sentVersion: _sent, downgradedFrom: _down,
    localWarnings: _local, serverFailures: _failures, taxRounding: _rounding, ...current } = posOrderSchema.properties;
  const { sessionId: _session, ...v0Properties } = current;
  const v1Properties = { ...v0Properties, sessionId: { type: 'string' } };
  const older = { ...posOrderSchema, required: posOrderSchema.required!.filter((key) => key !== 'taxRounding'),
    indexes: posOrderSchema.indexes!.filter((index) => index !== 'sessionId') };
  const olderSchemas = {
    0: { ...older, version: 0, properties: v0Properties as typeof posOrderSchema.properties },
    1: { ...older, version: 1, properties: v1Properties as typeof posOrderSchema.properties },
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
  // A stuck insert without a dead storage worker: `record()` hangs before its write until released.
  exposeE2eHook('HoldOrderInserts', () => {
    if (e2eInsertHold) return;
    let release!: () => void;
    e2eInsertHold = { promise: new Promise<void>((resolve) => { release = resolve; }), release: () => release(), waiting: 0 };
  });
  // How many inserts the hold has stopped, so a test knows the save got past its reads (the session stamp).
  exposeE2eHook('HeldOrderInserts', () => e2eInsertHold?.waiting ?? 0);
  exposeE2eHook('ReleaseOrderInserts', () => { e2eInsertHold?.release(); e2eInsertHold = undefined; });
  exposeE2eHook('FailNextClosureInsert', () => { e2eFailClosureInsert = true; });
}
