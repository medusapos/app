import { describe, expect, it, vi } from 'vitest';
import {
  addRxPlugin, createRevision, createRxDatabase, fillWithDefaultSettings, now, type RxCollection, type RxCollectionCreator, type RxDatabase, type RxJsonSchema,
} from 'rxdb';
import { RxDBDevModePlugin } from 'rxdb/plugins/dev-mode';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import { wrappedValidateAjvStorage } from 'rxdb/plugins/validate-ajv';
import { RxDBLocalDocumentsPlugin } from 'rxdb/plugins/local-documents';
import { addPosOrderCollection, createOrderBuilder, finalizeOrder, posOrderCollection, posOrderSchema, type PosOrder } from '@tallyui/pos';
import { carryOverOrders, closeOrderStores, openOrderStore, orderDatabaseName } from './order-store';

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

/**
 * The shipped older schemas, as TallyUI's open.test-helper builds them: version 1 is version 2
 * minus its only additions (`lateSessionId`, `display`, `taxByRate`; TallyUI c1a), and version 0
 * is version 1 minus its only addition (`sessionId`; TallyUI #123).
 */
function olderSchema(from: Origin): RxJsonSchema<PosOrder> {
  const schema = structuredClone(posOrderSchema);
  const properties = schema.properties as Record<string, unknown>;
  for (const key of ['lateSessionId', 'display', 'taxByRate', ...(from === 0 ? ['sessionId'] : [])]) delete properties[key];
  return { ...schema, version: from };
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
 * an unvalidated production build could have): it fails version 2's validation, so a validating
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
const olderSale = (from: Origin): PosOrder => ({ ...sale(), ...(from === 1 ? { sessionId: 'session-1' } : {}) });
// Valid at the older version when it was written, but not at version 2 (an unknown syncStatus).
const invalidSale = (from: Origin = 0) => ({ ...olderSale(from), syncStatus: 'queued' }) as unknown as PosOrder;
const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);

describe.each([0, 1] as const)('pos_orders schema v%i to v2', (from) => {
  it(`reopens a version-${from} order store through openOrderStore: the pending order is there, unchanged`, async () => {
    const url = `https://v${from}-store.test`;
    const name = orderDatabaseName(url);
    const pending = olderSale(from);
    const original = structuredClone(pending);
    await seedOlder(from, name, [pending]);
    expect(await olderDocuments(from, name, [pending.id])).toEqual([original]);
    const store = await openOrderStore(url);
    try {
      expect(store.orders.schema.version).toBe(2);
      const found = (await store.orders.findOne(pending.id).exec())?.toJSON();
      // Identity migrations: byte for byte the order that was stored, and none of version 2's fields added.
      expect(found).toStrictEqual(original);
      for (const added of ['lateSessionId', 'display', 'taxByRate']) expect(found).not.toHaveProperty(added);
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

  it(`after a DM4 and a fix to the v${from} data, the very next open migrates every order unchanged`, async () => {
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
      expect(store.orders.schema.version).toBe(2);
      expect((await store.orders.find().exec()).map((doc) => doc.toJSON()).sort(byId)).toEqual([pending, fixed].sort(byId));
    } finally { await store.close(); }
    expect(await olderDocuments(from, name, [pending.id, invalid.id])).toEqual([]);
  });
});
// The legacy database "exists" (memory storages have no IndexedDB to list).
const legacyExists = async () => true;

describe('carryOverOrders', () => {
  it('copies every document with its syncStatus, writes the marker, then removes the source', async () => {
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
    expect(await reopenedLegacy.pos_orders.find().exec()).toEqual([]);
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

    const legacyGone = await memoryOrdersDb(fromName);
    expect(await legacyGone.pos_orders.find().exec()).toEqual([]);
    await legacyGone.remove();
    await to.remove();
  });

  it('with the marker already present, still carries over a legacy sale with a new id before removing the source', async () => {
    // F1: another tab still on the old build wrote this sale after a first copy wrote the marker.
    const fromName = 'legacy-carry-marker';
    const legacy = await memoryOrdersDb(fromName);
    const late = sale();
    await legacy.pos_orders.insert(late);
    await legacy.close();

    const to = await memoryOrdersDb('target-carry-marker', true);
    const marker = { count: 1, at: new Date(0).toISOString() };
    await to.insertLocal('legacy-orders-migrated', marker);
    // Records the order of the insert into the new store and any removal of a source storage instance.
    const events: string[] = [];
    const realBulkInsert = to.pos_orders.bulkInsert.bind(to.pos_orders);
    vi.spyOn(to.pos_orders, 'bulkInsert').mockImplementationOnce(async (docs: PosOrder[]) => {
      const result = await realBulkInsert(docs);
      events.push(`inserted ${docs.map((doc) => doc.id).join()}`);
      return result;
    });
    const base = memoryStorage();
    const fromStorage: typeof base = { ...base, createStorageInstance: async (params) => {
      const instance = await base.createStorageInstance(params);
      const remove = instance.remove.bind(instance);
      instance.remove = async () => { events.push('source removed'); return remove(); };
      return instance;
    } };

    await carryOverOrders({ fromStorage, fromName, to, legacyExists });
    expect(events[0]).toBe(`inserted ${late.id}`);
    expect(events.slice(1)).toContain('source removed');
    expect((await to.pos_orders.find().exec()).map((doc) => doc.toJSON())).toEqual([late]);
    expect((await to.getLocal('legacy-orders-migrated'))?.toJSON().data).toEqual(marker);

    const legacyGone = await memoryOrdersDb(fromName);
    expect(await legacyGone.pos_orders.find().exec()).toEqual([]);
    await legacyGone.remove();
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

    const legacyGone = await memoryOrdersDb(fromName);
    expect(await legacyGone.pos_orders.find().exec()).toEqual([]);
    await legacyGone.remove();
    await to.remove();
  });

  it.each([0, 1] as const)('carries over a pending order from a version-%i legacy source through the version-2 open', async (from) => {
    const fromName = `legacy-carry-v${from}`;
    const pending = olderSale(from);
    const original = structuredClone(pending);
    await seedOlder(from, fromName, [pending]);
    const to = await memoryOrdersDb(`target-carry-v${from}`, true);
    expect(to.pos_orders.schema.version).toBe(2);
    await carryOverOrders({ fromStorage: memoryStorage(), fromName, to, legacyExists });
    expect((await to.pos_orders.find().exec()).map((doc) => doc.toJSON())).toStrictEqual([original]);
    expect((await to.getLocal('legacy-orders-migrated'))?.toJSON().data).toMatchObject({ count: 1 });
    expect(await olderDocuments(from, fromName, [pending.id])).toEqual([]);
    await to.remove();
  });

  it.each([0, 1] as const)('a DM4 on a version-%i legacy open keeps the source and writes no marker; after a fix, the next carry-over copies all once', async (from) => {
    const fromName = `legacy-carry-dm4-v${from}`;
    const pending = olderSale(from);
    const invalid = invalidSale(from);
    await seedOlder(from, fromName, [pending], invalid);
    const to = await memoryOrdersDb(`target-carry-dm4-v${from}`, true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const bulkInsert = vi.spyOn(to.pos_orders, 'bulkInsert');
    try {
      await carryOverOrders({ fromStorage: memoryStorage(), fromName, to, legacyExists });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('carry-over'), expect.objectContaining({ code: 'DM4' }));
      expect(await to.getLocal('legacy-orders-migrated')).toBeNull();
      expect(await to.pos_orders.find().exec()).toEqual([]);
      expect((await olderDocuments(from, fromName, [pending.id, invalid.id])).sort(byId)).toEqual([pending, invalid].sort(byId));

      const fixed: PosOrder = { ...invalid, syncStatus: 'pending' };
      await writeRawOlder(from, fromName, fixed);
      warn.mockClear();
      await carryOverOrders({ fromStorage: memoryStorage(), fromName, to, legacyExists });
      expect(warn).not.toHaveBeenCalled();
      expect(bulkInsert).toHaveBeenCalledTimes(1);
      expect((await to.pos_orders.find().exec()).map((doc) => doc.toJSON()).sort(byId)).toEqual([pending, fixed].sort(byId));
      expect((await to.getLocal('legacy-orders-migrated'))?.toJSON().data).toMatchObject({ count: 2 });
      expect(await olderDocuments(from, fromName, [pending.id, invalid.id])).toEqual([]);
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
