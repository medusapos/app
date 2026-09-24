import { describe, expect, it, vi } from 'vitest';
import { addRxPlugin, createRxDatabase, type RxCollection } from 'rxdb';
import { RxDBDevModePlugin } from 'rxdb/plugins/dev-mode';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import { wrappedValidateAjvStorage } from 'rxdb/plugins/validate-ajv';
import { RxDBLocalDocumentsPlugin } from 'rxdb/plugins/local-documents';
import { createOrderBuilder, finalizeOrder, posOrderSchema, type PosOrder } from '@tallyui/pos';
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
  await db.addCollections({ pos_orders: { schema: posOrderSchema } });
  return db;
}

describe('carryOverOrders', () => {
  it('copies every document with its syncStatus, writes the marker, then removes the source', async () => {
    const fromName = 'legacy-carry-basic';
    const legacy = await memoryOrdersDb(fromName);
    const pending = sale();
    const rejected: PosOrder = { ...sale(), syncStatus: 'rejected' };
    await legacy.pos_orders.bulkInsert([pending, rejected]);
    await legacy.close();

    const to = await memoryOrdersDb('target-carry-basic', true);
    await carryOverOrders({ fromStorage: wrappedValidateAjvStorage({ storage: getRxStorageMemory() }), fromName, to });

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
    const realBulkUpsert = to.pos_orders.bulkUpsert.bind(to.pos_orders);
    const spy = vi.spyOn(to.pos_orders, 'bulkUpsert').mockImplementationOnce(async (docs: Partial<PosOrder>[]) => {
      // Applies half for real, then crashes before the rest and before the marker.
      await realBulkUpsert(docs.slice(0, docs.length / 2));
      throw new Error('simulated crash mid carry-over');
    });

    await carryOverOrders({ fromStorage: wrappedValidateAjvStorage({ storage: getRxStorageMemory() }), fromName, to });
    expect(await to.getLocal('legacy-orders-migrated')).toBeNull();
    expect(await to.pos_orders.find().exec()).toHaveLength(2);

    const legacyStillThere = await memoryOrdersDb(fromName);
    expect(await legacyStillThere.pos_orders.find().exec()).toHaveLength(4);
    await legacyStillThere.close();

    spy.mockRestore();
    await carryOverOrders({ fromStorage: wrappedValidateAjvStorage({ storage: getRxStorageMemory() }), fromName, to });

    const finalIds = (await to.pos_orders.find().exec()).map((doc) => doc.id);
    expect(new Set(finalIds).size).toBe(finalIds.length);
    expect(finalIds.sort()).toEqual(orders.map((o) => o.id).sort());
    expect(await to.getLocal('legacy-orders-migrated')).not.toBeNull();

    const legacyGone = await memoryOrdersDb(fromName);
    expect(await legacyGone.pos_orders.find().exec()).toEqual([]);
    await legacyGone.remove();
    await to.remove();
  });

  it('skips the copy and removes a leftover source when the marker is already present', async () => {
    const fromName = 'legacy-carry-marker';
    const legacy = await memoryOrdersDb(fromName);
    await legacy.pos_orders.insert(sale());
    await legacy.close();

    const to = await memoryOrdersDb('target-carry-marker', true);
    await to.insertLocal('legacy-orders-migrated', { count: 0, at: new Date(0).toISOString() });

    await carryOverOrders({ fromStorage: wrappedValidateAjvStorage({ storage: getRxStorageMemory() }), fromName, to });
    expect(await to.pos_orders.find().exec()).toEqual([]);

    const legacyGone = await memoryOrdersDb(fromName);
    expect(await legacyGone.pos_orders.find().exec()).toEqual([]);
    await legacyGone.remove();
    await to.remove();
  });
});
