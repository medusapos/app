import { describe, expect, it, vi } from 'vitest';
import { addRxPlugin, createRevision, createRxDatabase, fillWithDefaultSettings, now, type RxCollection, type RxDatabase, type RxJsonSchema } from 'rxdb';
import { RxDBDevModePlugin } from 'rxdb/plugins/dev-mode';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import { wrappedValidateAjvStorage } from 'rxdb/plugins/validate-ajv';
import { RxDBLocalDocumentsPlugin } from 'rxdb/plugins/local-documents';
import { addPosOrderCollection, createOrderBuilder, finalizeOrder, posOrderSchema, type PosOrder } from '@tallyui/pos';
import { carryOverOrders, closeOrderStores, needsAttention, openOrderStore, orderDatabaseName } from './order-store';

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

  it('selects rejected and applied-with-warnings orders newest first without changing the input', () => {
    const base = sale();
    const rejected: PosOrder = { ...base, id: 'rejected', syncStatus: 'rejected', createdAt: '2026-01-01T00:00:00Z' };
    const warned: PosOrder = { ...base, id: 'warned', syncStatus: 'applied', createdAt: '2026-01-03T00:00:00Z',
      warnings: [{ code: 'insufficient_stock', variantId: 'blue', quantity: 1 }] };
    const orders: PosOrder[] = [rejected, base, { ...base, syncStatus: 'applied', warnings: [] }, warned,
      { ...base, syncStatus: 'applied' }, { ...base, warnings: warned.warnings }];
    expect(needsAttention(orders)).toEqual([warned, rejected]);
    expect(orders[0]).toBe(rejected);
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

/** The shipped version-0 schema: version 1 minus its only addition, `sessionId` (TallyUI #123). */
function versionZero(): RxJsonSchema<PosOrder> {
  const schema = structuredClone(posOrderSchema);
  delete (schema.properties as Record<string, unknown>).sessionId;
  return { ...schema, version: 0 };
}

/** The version-0 `pos_orders` storage beneath RxDB's collection (shared by name, like all memory storage). */
const rawV0 = (databaseName: string) => getRxStorageMemory().createStorageInstance<PosOrder>({
  databaseName, collectionName: 'pos_orders', schema: fillWithDefaultSettings(versionZero()),
  options: {}, multiInstance: false, devMode: false, databaseInstanceToken: 'test',
});

/**
 * A database written at version 0 holding `orders`, plus `invalid` written beneath RxDB (as an
 * unvalidated production build could have): it fails version 1's validation, so a validating
 * open's migration stops with DM4.
 */
async function seedV0(name: string, orders: PosOrder[], invalid?: PosOrder) {
  const db = await createRxDatabase({ name, storage: memoryStorage(), multiInstance: false });
  await (await db.addCollections({ pos_orders: { schema: versionZero() } })).pos_orders.bulkInsert(orders);
  await db.close();
  if (invalid) await writeRawV0(name, invalid);
}

/** Writes `order` into the version-0 storage beneath RxDB, over any stored copy (as a version-0 build could). */
async function writeRawV0(name: string, order: PosOrder) {
  const raw = await rawV0(name);
  try {
    const [previous] = await raw.findDocumentsById([order.id], false);
    const document = { ...order, _deleted: false, _attachments: {}, _meta: { lwt: now() }, _rev: createRevision('test', previous) };
    expect((await raw.bulkWrite([{ previous, document }], 'test')).error).toEqual([]);
  } finally { await raw.close(); }
}

/** The version-0 documents still in storage, without their storage metadata. */
async function v0Documents(name: string, ids: string[]) {
  const raw = await rawV0(name);
  try {
    return (await raw.findDocumentsById(ids, false)).map(({ _deleted, _attachments, _meta, _rev, ...doc }) => doc);
  } finally { await raw.close(); }
}

// Valid at version 0 when it was written, but not at version 1 (an unknown syncStatus).
const invalidSale = () => ({ ...sale(), syncStatus: 'queued' }) as unknown as PosOrder;
const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);

describe('pos_orders schema v0 to v1', () => {
  it('reopens a version-0 order store through addPosOrderCollection(): the pending order is there, unchanged', async () => {
    const url = 'https://v0-store.test';
    const pending = sale();
    await seedV0(orderDatabaseName(url), [pending]);
    const store = await openOrderStore(url);
    try {
      const found = (await store.orders.findOne(pending.id).exec())?.toJSON();
      expect(found).toEqual(pending);
      expect(found?.syncStatus).toBe('pending');
      expect(store.orders.schema.version).toBe(1);
    } finally { await store.close(); }
  });

  it('a DM4 fails the store open and deletes nothing; the next open retries it', async () => {
    const url = 'https://v0-store-dm4.test';
    const name = orderDatabaseName(url);
    const pending = sale();
    const invalid = invalidSale();
    await seedV0(name, [pending], invalid);
    for (let open = 0; open < 2; open++) {
      await expect(openOrderStore(url)).rejects.toMatchObject({ code: 'DM4' });
      expect((await v0Documents(name, [pending.id, invalid.id])).sort(byId)).toEqual([pending, invalid].sort(byId));
    }
  });

  it('after a DM4 and a fix to the v0 data, the very next open migrates every order unchanged', async () => {
    const url = 'https://v0-store-dm4-fix.test';
    const name = orderDatabaseName(url);
    const pending = sale();
    const invalid = invalidSale();
    await seedV0(name, [pending], invalid);
    await expect(openOrderStore(url)).rejects.toMatchObject({ code: 'DM4' });
    expect((await v0Documents(name, [pending.id, invalid.id])).sort(byId)).toEqual([pending, invalid].sort(byId));

    const fixed: PosOrder = { ...invalid, syncStatus: 'pending' };
    await writeRawV0(name, fixed);
    const store = await openOrderStore(url);
    try {
      expect((await store.orders.find().exec()).map((doc) => doc.toJSON()).sort(byId)).toEqual([pending, fixed].sort(byId));
    } finally { await store.close(); }
    expect(await v0Documents(name, [pending.id, invalid.id])).toEqual([]);
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

  it('carries over a pending order from a version-0 legacy source through the version-1 open', async () => {
    const fromName = 'legacy-carry-v0';
    const pending = sale();
    await seedV0(fromName, [pending]);
    const to = await memoryOrdersDb('target-carry-v0', true);
    await carryOverOrders({ fromStorage: memoryStorage(), fromName, to, legacyExists });
    expect((await to.pos_orders.find().exec()).map((doc) => doc.toJSON())).toEqual([pending]);
    expect((await to.getLocal('legacy-orders-migrated'))?.toJSON().data).toMatchObject({ count: 1 });
    expect(await v0Documents(fromName, [pending.id])).toEqual([]);
    await to.remove();
  });

  it('a DM4 on the legacy open keeps the source and writes no marker; after a fix, the next carry-over copies all once', async () => {
    const fromName = 'legacy-carry-dm4';
    const pending = sale();
    const invalid = invalidSale();
    await seedV0(fromName, [pending], invalid);
    const to = await memoryOrdersDb('target-carry-dm4', true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const bulkInsert = vi.spyOn(to.pos_orders, 'bulkInsert');
    try {
      await carryOverOrders({ fromStorage: memoryStorage(), fromName, to, legacyExists });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('carry-over'), expect.objectContaining({ code: 'DM4' }));
      expect(await to.getLocal('legacy-orders-migrated')).toBeNull();
      expect(await to.pos_orders.find().exec()).toEqual([]);
      expect((await v0Documents(fromName, [pending.id, invalid.id])).sort(byId)).toEqual([pending, invalid].sort(byId));

      const fixed: PosOrder = { ...invalid, syncStatus: 'pending' };
      await writeRawV0(fromName, fixed);
      warn.mockClear();
      await carryOverOrders({ fromStorage: memoryStorage(), fromName, to, legacyExists });
      expect(warn).not.toHaveBeenCalled();
      expect(bulkInsert).toHaveBeenCalledTimes(1);
      expect((await to.pos_orders.find().exec()).map((doc) => doc.toJSON()).sort(byId)).toEqual([pending, fixed].sort(byId));
      expect((await to.getLocal('legacy-orders-migrated'))?.toJSON().data).toMatchObject({ count: 2 });
      expect(await v0Documents(fromName, [pending.id, invalid.id])).toEqual([]);
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
