import { describe, expect, it } from 'vitest';
import { formatMoney } from '@tallyui/core';
import { createOrderBuilder, finalizeOrder, type PosOrder } from '@tallyui/pos';
import { ordersTableCells } from './orders-table';

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

  it('retryable only for a refused sale the outbox can requeue', () => {
    expect(ordersTableCells(sale(['cash'], { syncStatus: 'rejected', error: { code: 'platform_error', message: 'Refused' } })).retryable)
      .toBe(true);
    expect(ordersTableCells(sale(['cash'], { syncStatus: 'rejected', error: { code: 'idempotency_mismatch', message: 'Refused' } })).retryable)
      .toBe(false);
    expect(ordersTableCells(sale(['cash'], { syncStatus: 'applied' })).retryable).toBe(false);
    expect(ordersTableCells(sale(['cash'], { syncStatus: 'pending' })).retryable).toBe(false);
  });
});
