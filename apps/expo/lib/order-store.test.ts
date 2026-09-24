import { describe, expect, it } from 'vitest';
import { addRxPlugin } from 'rxdb';
import { RxDBDevModePlugin } from 'rxdb/plugins/dev-mode';
import { getLocalDocStateByParent } from 'rxdb/plugins/local-documents';
import { Platform } from 'react-native';
import { createOrderBuilder, finalizeOrder, type PosOrder } from '@tallyui/pos';
import { needsAttention, openOrderStore, orderDatabaseName } from './order-store';

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

  it('is multi-instance with local documents on web, single-instance on native', async () => {
    expect(Platform.OS).toBe('web'); // vitest aliases react-native to react-native-web
    const web = await openOrderStore('https://multi-instance.test');
    try {
      expect(web.orders.database.multiInstance).toBe(true);
      expect(() => getLocalDocStateByParent(web.orders.database)).not.toThrow();
    } finally { await web.close(); }

    const originalOS = Platform.OS;
    Platform.OS = 'ios';
    try {
      const native = await openOrderStore('https://single-instance.test');
      try {
        expect(native.orders.database.multiInstance).toBe(false);
        expect(() => getLocalDocStateByParent(native.orders.database)).toThrow();
      } finally { await native.close(); }
    } finally { Platform.OS = originalOS; }
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
