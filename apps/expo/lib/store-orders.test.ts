import { describe, expect, it } from 'vitest';
import type { StoreOrder } from '@tallyui/core';
import { createOrderBuilder, finalizeOrder, type PosOrder } from '@tallyui/pos';
import { mergeOrderRows, storeOrderDetailFigures, storeOrderStatus } from './store-orders';

function sale(createdAt: string, syncStatus: PosOrder['syncStatus'] = 'applied'): PosOrder {
  const builder = createOrderBuilder({ currency: 'EUR', taxContext: { pricesIncludeTax: false, getTaxRatePpm: () => 0 } });
  builder.addLine({ productId: 'shirt', variantId: 'blue', name: 'Blue shirt', unitPrice: { amount: 1200, currency: 'EUR' } });
  builder.addPayment({ method: 'cash', amountMinor: 1200 });
  return { ...finalizeOrder(builder.getSnapshot()), createdAt, syncStatus };
}

function storeOrder(id: string, extra: Partial<StoreOrder> = {}): StoreOrder {
  return {
    id, reference: id.replace('order_', ''), status: 'completed', placedAt: '2026-11-24T09:00:00.000Z', currency: 'EUR',
    pricesIncludeTax: false, customer: null, lines: [], fees: [], shipping: [], coupons: [], taxLines: [],
    discountMinor: 0, discountTaxMinor: 0, taxMinor: 0, totalMinor: 0, payments: [], refunds: [], ...extra,
  };
}

describe('mergeOrderRows', () => {
  it('lists the unsent sales newest first, then the store orders in the store\'s order', () => {
    const older = sale('2026-11-24T08:00:00.000Z', 'pending');
    const newer = sale('2026-11-24T10:00:00.000Z', 'pending');
    const rows = mergeOrderRows([older, newer], [older, newer], [storeOrder('order_2'), storeOrder('order_1')]);
    expect(rows.map((row) => [row.kind, row.key])).toEqual([
      ['local', newer.id], ['local', older.id], ['store', 'order_2'], ['store', 'order_1'],
    ]);
  });

  it('a store order the till created renders as the till\'s sale, keyed by its id, once', () => {
    const mine = sale('2026-11-24T08:00:00.000Z');
    const rows = mergeOrderRows([], [mine], [storeOrder('order_9', { clientOrderId: mine.id }), storeOrder('order_8')]);
    expect(rows).toEqual([{ kind: 'local', key: mine.id, order: mine }, { kind: 'store', key: 'order_8', order: storeOrder('order_8') }]);
  });

  it('an unsent sale the store already lists stays one row, the till\'s, where the unsent sales are', () => {
    const pending = sale('2026-11-24T08:00:00.000Z', 'pending');
    const rows = mergeOrderRows([pending], [pending], [storeOrder('order_7'), storeOrder('order_9', { clientOrderId: pending.id })]);
    expect(rows.map((row) => row.key)).toEqual([pending.id, 'order_7']);
  });

  it('a store order whose clientOrderId names no sale on this till is the store\'s row', () => {
    const rows = mergeOrderRows([], [], [storeOrder('order_5', { clientOrderId: 'another-till' })]);
    expect(rows).toEqual([{ kind: 'store', key: 'order_5', order: storeOrder('order_5', { clientOrderId: 'another-till' }) }]);
  });

  it('an order on two loaded pages is listed once', () => {
    expect(mergeOrderRows([], [], [storeOrder('order_1'), storeOrder('order_1')]).map((row) => row.key)).toEqual(['order_1']);
  });
});

describe('storeOrderStatus', () => {
  it.each([
    ['completed', 'completed'], ['pending', 'pending'], ['canceled', 'canceled'], ['requires_action', 'on-hold'],
    ['draft', 'pending'], ['archived', 'completed'], ['something_new', 'pending'], ['constructor', 'pending'],
  ])('Medusa\'s %s shows as %s', (status, badge) => {
    expect(storeOrderStatus(status)).toBe(badge);
  });
});

describe('storeOrderDetailFigures', () => {
  it('formats the receipt builder\'s figures, with Discount and Shipping only when the order has them', () => {
    const plain = storeOrder('order_1', {
      lines: [{ id: 'l1', name: 'Blue shirt', quantity: 2, subtotalMinor: 2400, subtotalTaxMinor: 0, totalMinor: 2400, taxMinor: 0 }],
      totalMinor: 2400,
    });
    expect(storeOrderDetailFigures(plain)).toEqual({
      lineItems: [{ name: 'Blue shirt', quantity: 2, total: '€24.00' }], subtotal: '€24.00', tax: '€0.00', total: '€24.00', taxLines: [],
    });
    const full = storeOrder('order_2', {
      lines: [{ id: 'l1', name: 'Blue shirt', quantity: 1, subtotalMinor: 1200, subtotalTaxMinor: 240, totalMinor: 1000, taxMinor: 200 }],
      shipping: [{ name: 'Courier', totalMinor: 500, taxMinor: 100 }],
      taxLines: [{ label: 'VAT 20%', ratePpm: 200_000, amountMinor: 300 }], taxMinor: 300, totalMinor: 1800,
    });
    expect(storeOrderDetailFigures(full)).toMatchObject({
      subtotal: '€12.00', discount: '-€2.00', shipping: '€5.00', tax: '€3.00', total: '€18.00',
      taxLines: [{ label: 'VAT 20%', amount: '€3.00' }],
    });
  });
});
