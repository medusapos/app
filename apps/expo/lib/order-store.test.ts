import { describe, expect, it, vi } from 'vitest';
import {
  addRxPlugin, createRevision, createRxDatabase, fillWithDefaultSettings, getAllCollectionDocuments, newRxError, now, type RxCollection,
  type RxCollectionCreator, type RxDatabase, type RxJsonSchema, type RxStorage,
} from 'rxdb';
import { RxDBDevModePlugin } from 'rxdb/plugins/dev-mode';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import { wrappedValidateAjvStorage } from 'rxdb/plugins/validate-ajv';
import { RxDBLocalDocumentsPlugin } from 'rxdb/plugins/local-documents';
import {
  addPosOrderCollection, bindRegister, createOrderBuilder, ensureRegister, finalizeOrder, getBoundRegisterId, openSession, PosOrderOpenClosedError,
  posOrderCollection, posOrderSchema, readRegister, recordMovement, type PosOrder,
} from '@tallyui/pos';
import {
  carryOverOrders, closeOrderStores, openOrderStore, ORDER_STORE_CLOSE_WAIT_MS, orderDatabaseName, registerCollections,
} from './order-store';

// ensureRegister, observed: the real one runs.
vi.mock('@tallyui/pos', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tallyui/pos')>();
  return { ...actual, ensureRegister: vi.fn(actual.ensureRegister) };
});

addRxPlugin(RxDBDevModePlugin);
addRxPlugin(RxDBLocalDocumentsPlugin);

function sale(): PosOrder {
  const builder = createOrderBuilder({ currency: 'EUR', taxContext: { pricesIncludeTax: false, getTaxRatePpm: () => 0 } });
  builder.addLine({ productId: 'shirt', variantId: 'blue', name: 'Blue shirt', unitPrice: { amount: 1200, currency: 'EUR' } });
  builder.addPayment({ method: 'cash', amountMinor: 1200 });
  return finalizeOrder(builder.getSnapshot());
}

describe('order store', () => {
  it('uses distinct RxDB names for punctuation, case, underscores and UTF-16 URLs', () => {
    const urls = ['https://shop-a.test', 'https://shop.a.test', 'https://Shop.test',
      'https://shop.test', 'https://shop_2d_a.test', 'https://shop.test/😀'];
    const names = urls.map(orderDatabaseName);
    expect(new Set(names).size).toBe(urls.length);
    for (const name of names) expect(name).toMatch(/^medusapos_sqlite_orders_[a-z0-9_$-]+$/);
    expect(orderDatabaseName('http://localhost:9000')).toBe('medusapos_sqlite_orders_http_3a__2f__2f_localhost_3a_9000');
    expect(names[2]).toContain('_53_');
    expect(names[5]).toContain('_d83d__de00_');
  });

  it('inserts finalized orders with dev-mode validation, reuses the store and preserves data on close', async () => {
    const first = await openOrderStore('https://orders.test');
    const second = await openOrderStore('https://orders.test');
    const order = sale();
    expect(first.orders).toBe(second.orders);
    await first.orders.insert(order);
    await first.close();
    expect((await second.orders.findOne(order.id).exec())?.toJSON()).toEqual(order);
    await second.close();
    const reopened = await openOrderStore('https://orders.test');
    try {
      expect((await reopened.orders.findOne(order.id).exec())?.toJSON()).toEqual(order);
    } finally { await reopened.close(); }
  });

  it('closes an open store and a still-opening store, and removes them', async () => {
    const opened = await openOrderStore('https://close-open.test');
    // Not awaited: still opening when closeOrderStores runs.
    const openingHandle = openOrderStore('https://close-opening.test');
    await closeOrderStores();
    expect(opened.orders.database.closed).toBe(true);
    const stillOpening = await openingHandle;
    expect(stillOpening.orders.database.closed).toBe(true);
  });

  it('leaves a store opened after the park open when a pre-park handle closes late, and reopens fresh', async () => {
    const preParkHandle = await openOrderStore('https://late-close.test');
    await closeOrderStores();
    const postParkHandle = await openOrderStore('https://late-close.test');
    await preParkHandle.close();
    expect(postParkHandle.orders.database.closed).toBe(false);
    await postParkHandle.orders.insert(sale());
    await postParkHandle.close();
    expect(postParkHandle.orders.database.closed).toBe(true);
  });

  it('a rejected close still frees the name: the caller sees the rejection, and the next open reads its orders', async () => {
    const url = 'https://reject-close.test';
    const first = await openOrderStore(url);
    const order = sale();
    await first.orders.insert(order);
    // The real close still runs (so RxDB itself deregisters the name), but the promise the code awaits rejects.
    const realClose = first.orders.database.close.bind(first.orders.database);
    vi.spyOn(first.orders.database, 'close').mockImplementationOnce(async () => {
      await realClose();
      throw new Error('close boom');
    });
    await expect(first.close()).rejects.toThrow('close boom');
    const second = await openOrderStore(url);
    try {
      expect((await second.orders.findOne(order.id).exec())?.toJSON()).toEqual(order);
    } finally { await second.close(); }
  });

  it('closeOrderStores rejects on a failed close but still frees the name, and the next open reads its orders', async () => {
    const url = 'https://reject-close-park.test';
    const handle = await openOrderStore(url);
    const order = sale();
    await handle.orders.insert(order);
    const realClose = handle.orders.database.close.bind(handle.orders.database);
    vi.spyOn(handle.orders.database, 'close').mockImplementationOnce(async () => {
      await realClose();
      throw new Error('park boom');
    });
    await expect(closeOrderStores()).rejects.toThrow('park boom');
    const reopened = await openOrderStore(url);
    try {
      expect((await reopened.orders.findOne(order.id).exec())?.toJSON()).toEqual(order);
    } finally { await reopened.close(); }
  });

  // The #85 review: RxDB's close waits, with no time limit, for a write in flight, and a hung save's insert may never
  // finish. The next open for that backend gives up after ORDER_STORE_CLOSE_WAIT_MS, so #80's prompt shows.
  async function closeHeldOpen(url: string) {
    const handle = await openOrderStore(url);
    const order = sale();
    await handle.orders.insert(order);
    const realClose = handle.orders.database.close.bind(handle.orders.database);
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(handle.orders.database, 'close').mockImplementationOnce(async () => { await released; return realClose(); });
    return { order, closing: handle.close(), release };
  }

  it('rejects an open still waiting on a stuck close after ORDER_STORE_CLOSE_WAIT_MS, with an ordinary Error and its code', async () => {
    const url = 'https://stuck-close.test';
    const { closing, release } = await closeHeldOpen(url);
    // Fakes only the timeouts; setImmediate stays real, to let every pending promise step run.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const settled = () => new Promise((resolve) => { setImmediate(resolve); });
    try {
      let outcome: unknown = 'pending';
      void openOrderStore(url).then(() => { outcome = 'opened'; }, (error: unknown) => { outcome = error; });
      await vi.advanceTimersByTimeAsync(ORDER_STORE_CLOSE_WAIT_MS - 1);
      await settled();
      expect(outcome).toBe('pending');
      await vi.advanceTimersByTimeAsync(1);
      await settled();
      expect(outcome).toBeInstanceOf(Error);
      expect(outcome).not.toBeInstanceOf(PosOrderOpenClosedError);
      expect((outcome as Error).message).toBe('The previous order store for this backend is still closing');
      // #80's prompt and Report a problem show this code.
      expect((outcome as Error & { code?: string }).code).toBe('ORDER_STORE_CLOSE_TIMEOUT');
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
    // Once the stuck close does finish, the name is free again.
    release();
    await closing;
    const reopened = await openOrderStore(url);
    await reopened.close();
  });

  it('waits for a close that settles within ORDER_STORE_CLOSE_WAIT_MS, then opens, and clears its timer', async () => {
    const url = 'https://slow-close.test';
    const { order, closing, release } = await closeHeldOpen(url);
    // Real timers: RxDB's own close and open need them. The limit's timer is found by its delay.
    const setTimer = vi.spyOn(globalThis, 'setTimeout');
    const clearTimer = vi.spyOn(globalThis, 'clearTimeout');
    try {
      const reopening = openOrderStore(url);
      const limit = setTimer.mock.calls.findIndex(([, delay]) => delay === ORDER_STORE_CLOSE_WAIT_MS);
      expect(limit).toBeGreaterThanOrEqual(0);
      release();
      await closing;
      const reopened = await reopening;
      try {
        expect(clearTimer).toHaveBeenCalledWith(setTimer.mock.results[limit].value);
        expect((await reopened.orders.findOne(order.id).exec())?.toJSON()).toEqual(order);
      } finally { await reopened.close(); }
    } finally { setTimer.mockRestore(); clearTimer.mockRestore(); }
  });
});

async function memoryOrdersDb(name: string, localDocuments = false) {
  // RxDBDevModePlugin (registered above) requires a schema validator at the top level.
  const db = await createRxDatabase<{ pos_orders: RxCollection<PosOrder> }>({
    name, storage: wrappedValidateAjvStorage({ storage: getRxStorageMemory() }), multiInstance: false, localDocuments,
  });
  await addPosOrderCollection(db as unknown as RxDatabase);
  return db;
}

const memoryStorage = () => wrappedValidateAjvStorage({ storage: getRxStorageMemory() });

/** A stored older `pos_orders` version, which the store's open migrates to the current one. */
type Origin = 0 | 1;
/** The optional fields versions 2 to 7 added, which no older app wrote (taxRounding: the one they made required). */
const ADDED_SINCE_V1 = ['lateSessionId', 'display', 'taxByRate', 'sentVersion', 'downgradedFrom', 'localWarnings',
  'serverFailures', 'taxRounding', 'saleId'];

/**
 * The shipped older schemas, as TallyUI's open.test-helper builds them: version 1 is version 7
 * minus the additions of versions 2 to 7 (`lateSessionId`, `display`, `taxByRate`; the `sessionId`
 * index and its `maxLength`, `sentVersion`, `downgradedFrom`; `localWarnings`, `serverFailures`;
 * the required `taxRounding`; `saleId`), and version 0 is version 1 minus its only addition (`sessionId`; TallyUI #123).
 */
function olderSchema(from: Origin): RxJsonSchema<PosOrder> {
  const schema = structuredClone(posOrderSchema);
  const properties = schema.properties as Record<string, unknown>;
  for (const key of ADDED_SINCE_V1) delete properties[key];
  if (from === 0) delete properties.sessionId;
  else properties.sessionId = { type: 'string' };
  return { ...schema, version: from, required: schema.required!.filter((key) => key !== 'taxRounding'),
    indexes: schema.indexes!.filter((index) => index !== 'sessionId') };
}

/** `pos_orders` as the shipped app at `from` added it: version 1 came with its identity strategy. */
function olderCollection(from: Origin): RxCollectionCreator<PosOrder> {
  posOrderCollection(); // loads the migration plugin that a version above 0 needs
  return from === 0 ? { schema: olderSchema(0) } : { schema: olderSchema(1), migrationStrategies: { 1: (doc: PosOrder) => doc } };
}

/** The version-`from` `pos_orders` storage beneath RxDB's collection (shared by name, like all memory storage). */
const rawOlder = (databaseName: string, from: Origin) => getRxStorageMemory().createStorageInstance<PosOrder>({
  databaseName, collectionName: 'pos_orders', schema: fillWithDefaultSettings(olderSchema(from)),
  options: {}, multiInstance: false, devMode: false, databaseInstanceToken: 'test',
});

/**
 * A database written at version `from` holding `orders`, plus `invalid` written beneath RxDB (as
 * an unvalidated production build could have): it fails version 7's validation, so a validating
 * open's migration stops with DM4.
 */
async function seedOlder(from: Origin, name: string, orders: PosOrder[], invalid?: PosOrder) {
  const db = await createRxDatabase({ name, storage: memoryStorage(), multiInstance: false });
  const { pos_orders: collection } = await db.addCollections({ pos_orders: olderCollection(from) });
  expect(collection.schema.version).toBe(from);
  await collection.bulkInsert(orders);
  await db.close();
  if (invalid) await writeRawOlder(from, name, invalid);
}

/** Writes `order` into the version-`from` storage beneath RxDB, over any stored copy (as that build could). */
async function writeRawOlder(from: Origin, name: string, order: PosOrder) {
  const raw = await rawOlder(name, from);
  try {
    const [previous] = await raw.findDocumentsById([order.id], false);
    const document = { ...order, _deleted: false, _attachments: {}, _meta: { lwt: now() }, _rev: createRevision('test', previous) };
    expect((await raw.bulkWrite([{ previous, document }], 'test')).error).toEqual([]);
  } finally { await raw.close(); }
}

/** The version-`from` documents still in storage, without their storage metadata. */
async function olderDocuments(from: Origin, name: string, ids: string[]) {
  const raw = await rawOlder(name, from);
  try {
    return (await raw.findDocumentsById(ids, false)).map(({ _deleted, _attachments, _meta, _rev, ...doc }) => doc);
  } finally { await raw.close(); }
}

/** A pending sale as the version-`from` app took it: a version-1 one carries its session (ADR-032). */
const olderSale = (from: Origin): PosOrder => {
  const { taxRounding: _taxRounding, saleId: _saleId, ...order } = sale();
  return { ...order, ...(from === 1 ? { sessionId: 'session-1' } : {}) } as PosOrder;
};
/**
 * An older order as the version-7 open leaves it: TallyUI's version-5 and version-6 migrations record
 * its `sentVersion` (its content version, 1 for these sales; #300) and the default `taxRounding` (#318).
 * Version 7 is the identity: older orders keep having no `saleId` (ADR-072).
 */
const migrated = (order: PosOrder): PosOrder =>
  ({ ...order, sentVersion: 1, taxRounding: { granularity: 'per_order', mode: 'half_away_from_zero' } });
// Valid at the older version when it was written, but not at version 7 (an unknown syncStatus).
const invalidSale = (from: Origin = 0) => ({ ...olderSale(from), syncStatus: 'queued' }) as unknown as PosOrder;
const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);

describe.each([0, 1] as const)('pos_orders schema v%i to v7', (from) => {
  it(`reopens a version-${from} order store through openOrderStore: the pending order is there, as TallyUI migrates it`, async () => {
    const url = `https://v${from}-store.test`;
    const name = orderDatabaseName(url);
    const pending = olderSale(from);
    const original = structuredClone(pending);
    await seedOlder(from, name, [pending]);
    expect(await olderDocuments(from, name, [pending.id])).toEqual([original]);
    const store = await openOrderStore(url);
    try {
      expect(store.orders.schema.version).toBe(7);
      const found = (await store.orders.findOne(pending.id).exec())?.toJSON();
      // Byte for byte the order that was stored plus what versions 5 and 6 record, and no other field added.
      // Version 7 is the identity, so `saleId` stays absent.
      expect(found).toStrictEqual(migrated(original));
      for (const added of ADDED_SINCE_V1.filter((key) => !(key in migrated(original)))) expect(found).not.toHaveProperty(added);
      // The outbox's own query still finds it.
      expect((await store.orders.find({ selector: { syncStatus: 'pending' } }).exec()).map((doc) => doc.id)).toEqual([pending.id]);
    } finally { await store.close(); }
    // Moved, not copied: nothing is left at the older version to migrate again.
    expect(await olderDocuments(from, name, [pending.id])).toEqual([]);
  });

  it('a DM4 fails the store open and deletes nothing; the next open retries it', async () => {
    const url = `https://v${from}-store-dm4.test`;
    const name = orderDatabaseName(url);
    const pending = olderSale(from);
    const invalid = invalidSale(from);
    await seedOlder(from, name, [pending], invalid);
    for (let open = 0; open < 2; open++) {
      await expect(openOrderStore(url)).rejects.toMatchObject({ code: 'DM4' });
      expect((await olderDocuments(from, name, [pending.id, invalid.id])).sort(byId)).toEqual([pending, invalid].sort(byId));
    }
  });

  it(`after a DM4 and a fix to the v${from} data, the very next open migrates every order`, async () => {
    const url = `https://v${from}-store-dm4-fix.test`;
    const name = orderDatabaseName(url);
    const pending = olderSale(from);
    const invalid = invalidSale(from);
    await seedOlder(from, name, [pending], invalid);
    await expect(openOrderStore(url)).rejects.toMatchObject({ code: 'DM4' });
    expect((await olderDocuments(from, name, [pending.id, invalid.id])).sort(byId)).toEqual([pending, invalid].sort(byId));

    const fixed: PosOrder = { ...invalid, syncStatus: 'pending' };
    await writeRawOlder(from, name, fixed);
    const store = await openOrderStore(url);
    try {
      expect(store.orders.schema.version).toBe(7);
      expect((await store.orders.find().exec()).map((doc) => doc.toJSON()).sort(byId)).toEqual([pending, fixed].map(migrated).sort(byId));
    } finally { await store.close(); }
    expect(await olderDocuments(from, name, [pending.id, invalid.id])).toEqual([]);
  });
});
// The legacy database "exists" (memory storages have no IndexedDB to list).
const legacyExists = async () => true;

/**
 * Memory storage under the check RxDB 17.5's Dexie storage makes before it opens anything
 * (plugins/storage-dexie/rx-storage-dexie.js, createStorageInstance): an index on a field that is not
 * required is refused with DXE1, as version 3's `sessionId` index is. Node has no IndexedDB for the
 * real storage; e2e/storage.spec.ts carries a legacy order over through it in Chromium.
 */
function dexieRules(): RxStorage<any, any> {
  const storage = memoryStorage();
  return { ...storage, createStorageInstance: async (params) => {
    const required: readonly string[] = params.schema.required ?? [];
    const optional = (params.schema.indexes ?? []).flat().find((field) => !field.includes('.') && !required.includes(field));
    if (optional) throw newRxError('DXE1', { field: optional });
    return storage.createStorageInstance(params);
  } };
}

/** The collections a memory database's internal store still records; RxDB removes the record with the database. */
async function storedCollections(name: string) {
  const db = await createRxDatabase({ name, storage: memoryStorage(), multiInstance: false });
  try {
    return (await getAllCollectionDocuments(db.internalStore)).map((meta) => meta.key);
  } finally { await db.close(); }
}

describe('carryOverOrders', () => {
  it('copies every document with its syncStatus, writes the marker, and keeps the source', async () => {
    const fromName = 'legacy-carry-basic';
    const legacy = await memoryOrdersDb(fromName);
    const pending = sale();
    const rejected: PosOrder = { ...sale(), syncStatus: 'rejected' };
    await legacy.pos_orders.bulkInsert([pending, rejected]);
    await legacy.close();

    const to = await memoryOrdersDb('target-carry-basic', true);
    await carryOverOrders({ fromStorage: memoryStorage(), fromName, to, legacyExists });

    const copied = (await to.pos_orders.find().exec()).map((doc) => doc.toJSON());
    expect(copied.sort((a, b) => a.id.localeCompare(b.id)))
      .toEqual([pending, rejected].sort((a, b) => a.id.localeCompare(b.id)));
    const marker = await to.getLocal('legacy-orders-migrated');
    expect(marker?.toJSON().data).toMatchObject({ count: 2 });

    const reopenedLegacy = await memoryOrdersDb(fromName);
    expect((await reopenedLegacy.pos_orders.find().exec()).map((doc) => doc.toJSON()).sort(byId)).toEqual([pending, rejected].sort(byId));
    await reopenedLegacy.remove();
    await to.remove();
  });

  it('is crash-safe: a failure keeps the source, and a retry ends with no duplicates and no marker loss', async () => {
    const fromName = 'legacy-carry-crash';
    const legacy = await memoryOrdersDb(fromName);
    const orders = [sale(), sale(), sale(), sale()];
    await legacy.pos_orders.bulkInsert(orders);
    await legacy.close();

    const to = await memoryOrdersDb('target-carry-crash', true);
    const realBulkInsert = to.pos_orders.bulkInsert.bind(to.pos_orders);
    const spy = vi.spyOn(to.pos_orders, 'bulkInsert').mockImplementationOnce(async (docs: PosOrder[]) => {
      // Applies half for real, then crashes before the rest and before the marker.
      await realBulkInsert(docs.slice(0, docs.length / 2));
      throw new Error('simulated crash mid carry-over');
    });

    await carryOverOrders({ fromStorage: memoryStorage(), fromName, to, legacyExists });
    expect(await to.getLocal('legacy-orders-migrated')).toBeNull();
    expect(await to.pos_orders.find().exec()).toHaveLength(2);

    const legacyStillThere = await memoryOrdersDb(fromName);
    expect(await legacyStillThere.pos_orders.find().exec()).toHaveLength(4);
    await legacyStillThere.close();

    spy.mockRestore();
    await carryOverOrders({ fromStorage: memoryStorage(), fromName, to, legacyExists });

    const finalIds = (await to.pos_orders.find().exec()).map((doc) => doc.id);
    expect(new Set(finalIds).size).toBe(finalIds.length);
    expect(finalIds.sort()).toEqual(orders.map((o) => o.id).sort());
    expect(await to.getLocal('legacy-orders-migrated')).not.toBeNull();

    const legacyKept = await memoryOrdersDb(fromName);
    expect((await legacyKept.pos_orders.find().exec()).map((doc) => doc.toJSON()).sort(byId)).toEqual(orders.sort(byId));
    await legacyKept.remove();
    await to.remove();
  });

  it('once the marker is written, a later open never reads the legacy database, even when it has a new order', async () => {
    // Another tab still on the old build writes a sale after the first copy wrote the marker.
    const fromName = 'legacy-carry-marker';
    const legacy = await memoryOrdersDb(fromName);
    const first = sale();
    await legacy.pos_orders.insert(first);
    await legacy.close();

    const to = await memoryOrdersDb('target-carry-marker', true);
    const bulkInsert = vi.spyOn(to.pos_orders, 'bulkInsert');
    await carryOverOrders({ fromStorage: memoryStorage(), fromName, to, legacyExists });
    const marker = (await to.getLocal('legacy-orders-migrated'))?.toJSON().data;
    expect(marker).toMatchObject({ count: 1 });
    const late = sale();
    const reopenedLegacy = await memoryOrdersDb(fromName);
    await reopenedLegacy.pos_orders.insert(late);
    await reopenedLegacy.close();
    const exists = vi.fn(legacyExists);

    await carryOverOrders({ fromStorage: memoryStorage(), fromName, to, legacyExists: exists });
    expect(exists).not.toHaveBeenCalled();
    expect(bulkInsert).toHaveBeenCalledTimes(1);
    expect((await to.pos_orders.find().exec()).map((doc) => doc.toJSON())).toEqual([first]);
    expect((await to.getLocal('legacy-orders-migrated'))?.toJSON().data).toEqual(marker);

    const legacyKept = await memoryOrdersDb(fromName);
    expect((await legacyKept.pos_orders.find().exec()).map((doc) => doc.toJSON()).sort(byId)).toEqual([first, late].sort(byId));
    await legacyKept.remove();
    await to.remove();
  });

  it('keeps the new store\'s copy of an order present in both (applied stays applied)', async () => {
    const fromName = 'legacy-carry-both';
    const order = sale();
    const legacy = await memoryOrdersDb(fromName);
    await legacy.pos_orders.insert({ ...order, syncStatus: 'pending' });
    await legacy.close();

    const to = await memoryOrdersDb('target-carry-both', true);
    await to.pos_orders.insert({ ...order, syncStatus: 'applied' });

    await carryOverOrders({ fromStorage: memoryStorage(), fromName, to, legacyExists });
    expect((await to.pos_orders.find().exec()).map((doc) => doc.syncStatus)).toEqual(['applied']);
    expect(await to.getLocal('legacy-orders-migrated')).not.toBeNull();

    const legacyKept = await memoryOrdersDb(fromName);
    expect((await legacyKept.pos_orders.find().exec()).map((doc) => doc.toJSON()).sort(byId)).toEqual([{ ...order, syncStatus: 'pending' }]);
    await legacyKept.remove();
    await to.remove();
  });

  it.each([0, 1] as const)('carries over a pending order from a version-%i legacy source through the version-7 open', async (from) => {
    const fromName = `legacy-carry-v${from}`;
    const pending = olderSale(from);
    const original = structuredClone(pending);
    await seedOlder(from, fromName, [pending]);
    const to = await memoryOrdersDb(`target-carry-v${from}`, true);
    expect(to.pos_orders.schema.version).toBe(7);
    await carryOverOrders({ fromStorage: memoryStorage(), fromName, to, legacyExists });
    expect((await to.pos_orders.find().exec()).map((doc) => doc.toJSON())).toStrictEqual([migrated(original)]);
    expect((await to.getLocal('legacy-orders-migrated'))?.toJSON().data).toMatchObject({ count: 1 });
    expect(await olderDocuments(from, fromName, [pending.id])).toEqual([original]);
    await to.remove();
  });

  it.each([0, 1] as const)('carries a version-%i order over from a store under Dexie\'s index rule, keeps the source, and a rerun is a no-op', async (from) => {
    const fromName = `legacy-carry-dexie-v${from}`;
    const pending = olderSale(from);
    const original = structuredClone(pending);
    await seedOlder(from, fromName, [pending]);
    const to = await memoryOrdersDb(`target-carry-dexie-v${from}`, true);
    const warn = vi.spyOn(console, 'warn');
    const bulkInsert = vi.spyOn(to.pos_orders, 'bulkInsert');
    const carryOver = () => carryOverOrders({ fromStorage: dexieRules(), fromName, to, legacyExists });
    try {
      await carryOver();
      // First, so a DXE1 (an open at the current schema, M1) shows in the failure.
      expect(warn).not.toHaveBeenCalled();
      // Every field it had, plus what TallyUI's v5 and v6 strategies record (M2's catch), and nothing else.
      // The v7 identity step leaves `saleId` absent.
      const expected = [migrated(original)];
      expect((await to.pos_orders.find().exec()).map((doc) => doc.toJSON())).toStrictEqual(expected);
      const marker = (await to.getLocal('legacy-orders-migrated'))?.toJSON().data;
      expect(marker).toMatchObject({ count: 1 });
      expect(await olderDocuments(from, fromName, [pending.id])).toEqual([original]);
      expect(await storedCollections(fromName)).toEqual([`pos_orders-${from}`]);

      await carryOver();
      expect(warn).not.toHaveBeenCalled();
      expect(bulkInsert).toHaveBeenCalledTimes(1);
      expect((await to.pos_orders.find().exec()).map((doc) => doc.toJSON())).toStrictEqual(expected);
      expect((await to.getLocal('legacy-orders-migrated'))?.toJSON().data).toEqual(marker);
      expect(await storedCollections(fromName)).toEqual([`pos_orders-${from}`]);
    } finally {
      warn.mockRestore();
      await to.remove();
    }
  });

  // The legacy store is read, never migrated in place, so no DM4: the new store refuses the order v7 rejects, and the
  // read-back keeps the marker absent on failure (M3), so the next open retries the copy.
  it.each([0, 1] as const)('an order v7 refuses keeps the version-%i legacy source and writes no marker; after a fix, the next carry-over copies the rest once', async (from) => {
    const fromName = `legacy-carry-dm4-v${from}`;
    const pending = olderSale(from);
    const invalid = invalidSale(from);
    await seedOlder(from, fromName, [pending], invalid);
    const to = await memoryOrdersDb(`target-carry-dm4-v${from}`, true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const bulkInsert = vi.spyOn(to.pos_orders, 'bulkInsert');
    try {
      await carryOverOrders({ fromStorage: memoryStorage(), fromName, to, legacyExists });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('carry-over'), expect.objectContaining({
        message: expect.stringContaining('only 1 of 2 legacy orders verified') }));
      expect(await to.getLocal('legacy-orders-migrated')).toBeNull();
      expect((await to.pos_orders.find().exec()).map((doc) => doc.toJSON())).toEqual([migrated(pending)]);
      expect((await olderDocuments(from, fromName, [pending.id, invalid.id])).sort(byId)).toEqual([pending, invalid].sort(byId));

      const fixed: PosOrder = { ...invalid, syncStatus: 'pending' };
      await writeRawOlder(from, fromName, fixed);
      warn.mockClear();
      await carryOverOrders({ fromStorage: memoryStorage(), fromName, to, legacyExists });
      expect(warn).not.toHaveBeenCalled();
      // The second run inserts only the fixed order: the copy already there wins.
      expect(bulkInsert).toHaveBeenCalledTimes(2);
      expect(bulkInsert).toHaveBeenLastCalledWith([migrated(fixed)]);
      expect((await to.pos_orders.find().exec()).map((doc) => doc.toJSON()).sort(byId)).toEqual([pending, fixed].map(migrated).sort(byId));
      expect((await to.getLocal('legacy-orders-migrated'))?.toJSON().data).toMatchObject({ count: 2 });
      expect((await olderDocuments(from, fromName, [pending.id, invalid.id])).sort(byId)).toEqual([pending, fixed].sort(byId));
    } finally {
      warn.mockRestore();
      await to.remove();
    }
  });

  it('opens and creates nothing, and writes no marker, when no legacy database exists', async () => {
    const createStorageInstance = vi.fn();
    const fromStorage = { ...memoryStorage(), createStorageInstance };
    const warn = vi.spyOn(console, 'warn');
    const to = await memoryOrdersDb('target-carry-none', true);
    try {
      await expect(carryOverOrders({
        fromStorage, fromName: 'legacy-carry-none', to, legacyExists: async () => false,
      })).resolves.toBeUndefined();
      expect(createStorageInstance).not.toHaveBeenCalled();
      expect(await to.getLocal('legacy-orders-migrated')).toBeNull();
      expect(await to.pos_orders.find().exec()).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      await to.remove();
    }
  });
});

// The register collections (ADR 0017) live in the order store's database, next to pos_orders.
describe('register collections in the order store', () => {
  const opened = { registerId: 'register-1', expectedFloatMinor: null, countedFloatMinor: 10000, openedBy: 'cashier@store.test',
    businessDay: { year: 2026, month: 9, day: 28 } };

  it('adds register_commands (schema version 0) beside the register collections', async () => {
    const store = await openOrderStore('https://register-commands.test');
    try {
      const { commands, sessions } = registerCollections(store.orders);
      expect(commands.name).toBe('register_commands');
      expect(commands.schema.version).toBe(0);
      expect(commands.database).toBe(sessions.database);
    } finally { await store.close(); }
  });

  it('open with the order store, and keep their sessions, movements and binding over a close and reopen', async () => {
    const url = 'https://registers.test';
    const first = await openOrderStore(url);
    const { sessions, movements, closures } = registerCollections(first.orders);
    for (const collection of [sessions, movements, closures]) expect(collection.database).toBe(first.orders.database);
    expect(sessions.schema.version).toBe(0);
    await bindRegister(sessions, url, { id: 'register-1', name: 'Register 1' });
    const session = await openSession(sessions, { ...opened, storeKey: url });
    await recordMovement(sessions, movements, closures, { sessionId: session.id, type: 'paid_in', amountMinor: 500, reason: 'Change', actor: 'cashier@store.test' });
    const register = await readRegister(sessions);
    await first.close();
    expect(first.orders.database.closed).toBe(true);
    const reopened = await openOrderStore(url);
    try {
      const again = registerCollections(reopened.orders);
      expect(await readRegister(again.sessions)).toEqual(register);
      expect(getBoundRegisterId(await readRegister(again.sessions), url)).toBe('register-1');
      expect((await again.sessions.findOne(session.id).exec())?.status).toBe('open');
      expect((await again.movements.find().exec()).map((row) => [row.type, row.amountMinor])).toEqual([['paid_in', 500]]);
    } finally { await reopened.close(); }
  });

  it('runs ensureRegister once per database open, and mints the register document only once', async () => {
    const url = 'https://register-once.test';
    vi.mocked(ensureRegister).mockClear();
    const [a, b] = await Promise.all([openOrderStore(url), openOrderStore(url)]);
    expect(ensureRegister).toHaveBeenCalledTimes(1);
    expect(ensureRegister).toHaveBeenCalledWith(registerCollections(a.orders).sessions, 'web');
    const minted = await readRegister(registerCollections(a.orders).sessions);
    expect(minted?.platform).toBe('web');
    await a.close();
    await b.close();
    const reopened = await openOrderStore(url);
    try {
      expect(ensureRegister).toHaveBeenCalledTimes(2);
      expect(await readRegister(registerCollections(reopened.orders).sessions)).toEqual(minted);
    } finally { await reopened.close(); }
  });
});
