import { describe, expect, it, vi } from 'vitest';
import { getAllCollectionDocuments } from 'rxdb';
import { bindRegister, createOrderBuilder, finalizeOrder, openSession, readRegister, recordMovement, voidMovement, writeOrderDraft } from '@tallyui/pos';
import * as orderStore from './order-store';
import { dumpAppStore } from './app-store-dump';

async function seed(baseUrl: string) {
  const store = await orderStore.openOrderStore(baseUrl);
  const { sessions, movements, closures } = orderStore.registerCollections(store.orders);
  const builder = createOrderBuilder({ currency: 'EUR', taxContext: { pricesIncludeTax: false, getTaxRatePpm: () => 0 } });
  const lineId = builder.addLine({ productId: 'shirt', variantId: 'blue', name: 'Blue shirt', unitPrice: { amount: 1200, currency: 'EUR' } });
  const drafts = orderStore.draftsCollection(store.orders)!;
  const draftId = await writeOrderDraft(drafts, builder.getSnapshot());
  builder.addPayment({ method: 'cash', amountMinor: 1200 });
  // The default query sorts by createdAt, deliberately opposite to the primary keys.
  const pending = await store.orders.insert({ ...finalizeOrder(builder.getSnapshot()), id: 'z-order', createdAt: '2026-09-28T08:00:00Z' });
  builder.applyLineDiscount(lineId, { type: 'fixed', value: 100, label: 'Staff' });
  const discounted = await store.orders.insert({ ...finalizeOrder(builder.getSnapshot(), { capabilities: { orderCreate: 3 } }), id: 'a-order', createdAt: '2026-09-28T09:00:00Z' });
  await bindRegister(sessions, baseUrl, { id: 'register-1', name: 'Register 1' });
  const session = await openSession(sessions, { registerId: 'register-1', storeKey: baseUrl,
    expectedFloatMinor: null, countedFloatMinor: 10000, openedBy: 'cashier@store.test', businessDay: { year: 2026, month: 9, day: 28 } });
  const paidIn = await recordMovement(sessions, movements, closures, {
    sessionId: session.id, type: 'paid_in', amountMinor: 500, reason: 'Change', actor: 'cashier@store.test',
  });
  const voided = await voidMovement(sessions, movements, paidIn.id, 'cashier@store.test', closures);
  const closure = await closures.insert({
    id: session.id, session_id: session.id, register_id: 'register-1', number: 1,
    opened_at: '2026-09-28T08:00:00Z', closed_at: '2026-09-28T17:00:00Z',
    till_expected: { cash: 10000 }, expected: { cash: 10000 }, counted: { cash: 10000 }, variance: { cash: 0 },
    period_sales_total_minor: 0, period_refunds_total_minor: 0, perpetual_sales_total_minor: 0, perpetual_refunds_total_minor: 0,
    unsynced_count: 2, unsynced_total_minor: 2300, software_version: 'test', breakdowns: {},
    order_ids: [pending.id, discounted.id], movement_ids: [paidIn.id, voided.id], print_count: 0,
  });
  return { store, sessions, collections: [store.orders, sessions, movements, closures, drafts], inserted: {
    pos_orders: [discounted, pending], register_sessions: [await sessions.findOne(session.id).exec(true)],
    cash_movements: [paidIn.getLatest(), voided].sort((a, b) => a.id.localeCompare(b.id)), closures: [closure],
    drafts: [await drafts.findOne(draftId).exec(true)],
  } };
}

describe('dumpAppStore', () => {
  it('returns the whole store, sorted, with no bookkeeping fields', async () => {
    const url = 'https://dump-whole.test';
    const { store, sessions, inserted } = await seed(url);
    try {
      const dump = await dumpAppStore(url);
      expect(dump.rxdbVersion).toBe('17.5.0');
      expect(dump.stored).toStrictEqual([
        { name: 'cash_movements', version: 0 }, { name: 'closures', version: 0 }, { name: 'drafts', version: 0 },
        { name: 'pos_orders', version: 7 }, { name: 'register_commands', version: 0 }, { name: 'register_sessions', version: 0 },
      ]);
      for (const name of Object.keys(inserted) as (keyof typeof inserted)[]) {
        expect(dump.docs[name]).toStrictEqual(inserted[name].map((doc) => doc.toJSON()));
        for (const doc of dump.docs[name]) expect(Object.keys(doc).filter((key) => key.startsWith('_'))).toEqual([]);
      }
      expect(dump.register).toStrictEqual(await readRegister(sessions));
    } finally { await store.close(); }
  });

  it('closes only its own handle, including when it is the only handle', async () => {
    // Observe the real opens to inspect the database owned by a dump with no other caller.
    const opened = vi.spyOn(orderStore, 'openOrderStore');
    try {
      const url = 'https://dump-handles.test';
      const other = await orderStore.openOrderStore(url);
      await dumpAppStore(url);
      expect(other.orders.database.closed).toBe(false);
      const builder = createOrderBuilder({ currency: 'EUR', taxContext: { pricesIncludeTax: false, getTaxRatePpm: () => 0 } });
      builder.addLine({ productId: 'shirt', name: 'Shirt', unitPrice: { amount: 1200, currency: 'EUR' } });
      builder.addPayment({ method: 'cash', amountMinor: 1200 });
      const inserted = await other.orders.insert(finalizeOrder(builder.getSnapshot()));
      expect(await other.orders.findOne(inserted.id).exec()).not.toBeNull();
      await other.close();
      expect(other.orders.database.closed).toBe(true);

      const ownUrl = 'https://dump-only-handle.test';
      const call = opened.mock.results.length;
      await dumpAppStore(ownUrl);
      const own = await opened.mock.results[call].value;
      expect(own.orders.database.closed).toBe(true);
      const later = await orderStore.openOrderStore(ownUrl);
      expect(later.orders.database).not.toBe(own.orders.database);
    } finally {
      for (const result of opened.mock.results) await (await result.value).close();
      opened.mockRestore();
    }
  });

  it('is read only: revisions and document counts are unchanged', async () => {
    const url = 'https://dump-read-only.test';
    const { store, sessions, collections } = await seed(url);
    try {
      const snapshot = async () => ({
        docs: await Promise.all(collections.map(async (collection) =>
          (await collection.find().exec()).map((doc) => doc.toJSON(true)))),
        register: (await sessions.getLocal('register'))!.toJSON(true),
        stored: await getAllCollectionDocuments(store.orders.database.internalStore),
      });
      const before = await snapshot();
      await dumpAppStore(url);
      expect(await snapshot()).toStrictEqual(before);
    } finally { await store.close(); }
  });
});
