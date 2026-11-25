import { describe, expect, it } from 'vitest';
import { formatMoney } from '@tallyui/core';
import type { StoreOrder } from '@tallyui/core';
import { createOrderBuilder, finalizeOrder, UPDATE_UNSENDABLE, type PosOrder } from '@tallyui/pos';
import { groupOrderRowsByDay, orderBillingCell, ordersTableCells } from './orders-table';
import type { OrdersRow } from './store-orders';

function sale(methods: ('cash' | 'external')[] = ['cash'], extra: Partial<PosOrder> = {}): PosOrder {
  const builder = createOrderBuilder({ currency: 'EUR', taxContext: { pricesIncludeTax: false, getTaxRatePpm: () => 0 } });
  builder.addLine({ productId: 'shirt', variantId: 'blue', name: 'Blue shirt', unitPrice: { amount: 1200, currency: 'EUR' } });
  methods.forEach((method, index) => builder.addPayment({ method, amountMinor: index === 0 ? 1200 - 200 * (methods.length - 1) : 200 }));
  return { ...finalizeOrder(builder.getSnapshot()), syncStatus: 'applied', ...extra };
}

describe('ordersTableCells', () => {
  it('customer is the name, else the email, else Guest', () => {
    expect(ordersTableCells(sale(['cash'], { customer: { id: 'c1', name: 'Ada Lovelace', email: 'ada@store.test' } })).customer)
      .toBe('Ada Lovelace');
    expect(ordersTableCells(sale(['cash'], { customer: { id: 'c1', email: 'ada@store.test' } })).customer).toBe('ada@store.test');
    expect(ordersTableCells(sale(['cash'], { customer: null })).customer).toBe('Guest');
    expect(ordersTableCells(sale(['cash'], { customer: {} })).customer).toBe('Guest');
  });

  it('cashier is the cashierRef, and a dash when it is absent or empty', () => {
    expect(ordersTableCells(sale(['cash'], { cashierRef: 'ann@store.test' })).cashier).toBe('ann@store.test');
    expect(ordersTableCells(sale(['cash'], { cashierRef: undefined })).cashier).toBe('—');
    expect(ordersTableCells(sale(['cash'], { cashierRef: '' })).cashier).toBe('—');
  });

  it('payment lists each payment word once, in first-seen order', () => {
    expect(ordersTableCells(sale(['cash'])).payment).toBe('Cash');
    expect(ordersTableCells(sale(['cash', 'external'])).payment).toBe('Cash, Card terminal');
    expect(ordersTableCells(sale(['cash', 'cash'])).payment).toBe('Cash');
    expect(ordersTableCells(sale(['cash'], { payments: [] })).payment).toBe('—');
  });

  it('total is the stored totalMinor, formatted', () => {
    const order = sale();
    expect(ordersTableCells(order).total).toBe(formatMoney({ amount: order.totalMinor, currency: 'EUR' }));
  });

  it('total stays the till\'s stored figure when the store reports another or the payments differ', () => {
    const order = sale(['cash'], { serverRefs: { orderId: 'server', displayId: '42', totalMinor: 1000 } });
    const total = formatMoney({ amount: order.totalMinor, currency: 'EUR' });
    expect(ordersTableCells(order).total).toBe(total);
    expect(ordersTableCells({ ...order, payments: [{ ...order.payments[0]!, amountMinor: 5000 }] }).total).toBe(total);
  });

  it('retryable only for a refused sale the outbox can requeue', () => {
    expect(ordersTableCells(sale(['cash'], { syncStatus: 'rejected', error: { code: 'platform_error', message: 'Refused' } })).retryable)
      .toBe(true);
    expect(ordersTableCells(sale(['cash'], { syncStatus: 'rejected', error: { code: 'idempotency_mismatch', message: 'Refused' } })).retryable)
      .toBe(false);
    expect(ordersTableCells(sale(['cash'], { syncStatus: 'applied' })).retryable).toBe(false);
    expect(ordersTableCells(sale(['cash'], { syncStatus: 'pending' })).retryable).toBe(false);
  });

  it('retryable for a pending sale the store cannot accept yet (UPDATE_UNSENDABLE), as OrdersList offers it', () => {
    expect(ordersTableCells(sale(['cash'], { syncStatus: 'pending', error: { code: UPDATE_UNSENDABLE, message: 'Not yet' } })).retryable)
      .toBe(true);
  });

  it('not retryable for a reopened sale refused with reopen_required, which needs a fresh reopen', () => {
    const refused = { syncStatus: 'rejected', error: { code: 'reopen_required', message: 'Reopen first' } } as const;
    expect(ordersTableCells(sale(['cash'], { ...refused, storeOrderId: 'order_1' })).retryable).toBe(false);
    expect(ordersTableCells(sale(['cash'], refused)).retryable).toBe(true);
  });
});

const storeOrder = (id: string, placedAt = '2026-11-24T09:00:00.000Z'): StoreOrder => ({
  id, reference: id, status: 'completed', placedAt, currency: 'EUR', pricesIncludeTax: false, customer: null, lines: [], fees: [],
  shipping: [], coupons: [], taxLines: [], discountMinor: 0, discountTaxMinor: 0, taxMinor: 0, totalMinor: 0, payments: [], refunds: [],
});
const local = (order: PosOrder, storeId?: string): OrdersRow => ({ kind: 'local', key: order.id, order, ...(storeId ? { storeId } : {}) });
const store = (order: StoreOrder): OrdersRow => ({ kind: 'store', key: order.id, order });

describe('orderBillingCell', () => {
  const billing = new Map<string, string | null>([['order_1', 'Nørregade 1, Copenhagen, 1165, DK'], ['order_2', null]]);
  const own = { id: 'c1', name: 'Ada', billing: { firstName: 'Ada', address1: 'Main St 5', city: 'Berlin', country: 'de' } };

  it('a till\'s sale with a stored address reads its own, even when it stands for a store order', () => {
    expect(orderBillingCell(local(sale(['cash'], { customer: own })), billing)).toBe('Main St 5, Berlin, DE');
    expect(orderBillingCell(local(sale(['cash'], { customer: own }), 'order_1'), billing)).toBe('Main St 5, Berlin, DE');
  });
  it('a till\'s sale without one reads its store order\'s, — when the store has none, empty while unanswered', () => {
    const blank = { id: 'c1', billing: { firstName: 'Ada', address1: ' ' } };
    expect(orderBillingCell(local(sale(['cash'], { customer: null }), 'order_1'), billing)).toBe('Nørregade 1, Copenhagen, 1165, DK');
    expect(orderBillingCell(local(sale(['cash'], { customer: blank }), 'order_1'), billing)).toBe('Nørregade 1, Copenhagen, 1165, DK');
    expect(orderBillingCell(local(sale(['cash'], { customer: null }), 'order_2'), billing)).toBe('—');
    expect(orderBillingCell(local(sale(['cash'], { customer: null }), 'order_3'), billing)).toBe('');
  });
  it('a store order reads the store\'s answer: the text, — for none, empty while unanswered', () => {
    expect(orderBillingCell(store(storeOrder('order_1')), billing)).toBe('Nørregade 1, Copenhagen, 1165, DK');
    expect(orderBillingCell(store(storeOrder('order_2')), billing)).toBe('—');
    expect(orderBillingCell(store(storeOrder('order_3')), billing)).toBe('');
  });
  it('an unsent sale, or one in the offline list, with no address of its own reads —', () => {
    expect(orderBillingCell(local(sale(['cash'], { customer: null })), billing)).toBe('—');
    expect(orderBillingCell(local(sale(['cash'], { customer: { id: 'c1', name: 'Ada' } })), new Map())).toBe('—');
  });
});

describe('groupOrderRowsByDay', () => {
  const at = (...parts: [number, number, number, number, number]) => new Date(...parts).toISOString();
  const groups = (rows: OrdersRow[]) => groupOrderRowsByDay(rows).map(({ day, rows: dayRows }) => [day, dayRows.map((row) => row.key)]);

  it('newest local day first, one group per day, each day\'s rows in the order given; an unsent sale of yesterday under today\'s rows', () => {
    const unsentYesterday = sale(['cash'], { createdAt: at(2026, 10, 24, 18, 0), syncStatus: 'pending' });
    const mineToday = sale(['cash'], { createdAt: at(2026, 10, 25, 8, 0) });
    const rows = [local(unsentYesterday), store(storeOrder('order_today_late', at(2026, 10, 25, 16, 0))), local(mineToday, 'order_9'),
      store(storeOrder('order_yesterday', at(2026, 10, 24, 9, 0))), store(storeOrder('order_today_early', at(2026, 10, 25, 7, 0))),
      store(storeOrder('order_old', at(2025, 11, 31, 12, 0)))];
    expect(groups(rows)).toEqual([
      ['2026-11-25', ['order_today_late', mineToday.id, 'order_today_early']],
      ['2026-11-24', [unsentYesterday.id, 'order_yesterday']],
      ['2025-12-31', ['order_old']],
    ]);
  });
  it('keeps the given order inside a day even when it is not by time', () => {
    const rows = [store(storeOrder('order_a', at(2026, 10, 25, 7, 0))), store(storeOrder('order_b', at(2026, 10, 25, 20, 0)))];
    expect(groups(rows)).toEqual([['2026-11-25', ['order_a', 'order_b']]]);
  });
  it('splits at local midnight: 23:59 and 00:00 are two days, 00:00 and 23:59 one', () => {
    const rows = [store(storeOrder('order_late', at(2026, 10, 24, 23, 59))), store(storeOrder('order_midnight', at(2026, 10, 25, 0, 0))),
      store(storeOrder('order_end', at(2026, 10, 25, 23, 59)))];
    expect(groups(rows)).toEqual([['2026-11-25', ['order_midnight', 'order_end']], ['2026-11-24', ['order_late']]]);
  });
  it('a row whose date cannot be read goes last, under no day; no row is dropped or repeated', () => {
    const corrupt = sale(['cash'], { createdAt: 'corrupt date' });
    const rows = [local(corrupt), store(storeOrder('order_1', at(2026, 10, 24, 9, 0))), store(storeOrder('order_2', ''))];
    expect(groups(rows)).toEqual([['2026-11-24', ['order_1']], [null, [corrupt.id, 'order_2']]]);
    expect(groupOrderRowsByDay([])).toEqual([]);
  });
});
