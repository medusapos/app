import { describe, expect, it } from 'vitest';
import { addRxPlugin } from 'rxdb';
import { RxDBDevModePlugin } from 'rxdb/plugins/dev-mode';
import { createOrderBuilder, finalizeOrder, type PosOrder } from '@tallyui/pos';
import { closeOrderStores, needsAttention, openOrderStore, orderDatabaseName } from './order-store';

addRxPlugin(RxDBDevModePlugin);

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
    for (const name of names) expect(name).toMatch(/^medusapos_orders_[a-z0-9_$-]+$/);
    expect(orderDatabaseName('http://localhost:9000')).toBe('medusapos_orders_http_3a__2f__2f_localhost_3a_9000');
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
