import { describe, expect, it, vi } from 'vitest';
import { formatMoney } from '@tallyui/core';
import { buildReceiptDataFromPosOrder, createOrderBuilder, finalizeOrder, type PosOrder } from '@tallyui/pos';
import { canSyncOrder, orderDetailFigures, orderStatusBadge, paymentLabel, syncOrder } from './order-detail';

function sale(): PosOrder {
  const builder = createOrderBuilder({ currency: 'EUR', taxContext: { pricesIncludeTax: false, getTaxRatePpm: () => 250000 } });
  builder.addLine({ productId: 'shirt', variantId: 'blue', name: 'Blue shirt', unitPrice: { amount: 1200, currency: 'EUR' } });
  builder.addLine({ productId: 'hat', variantId: 'red', name: 'Red hat', quantity: 2, unitPrice: { amount: 800, currency: 'EUR' } });
  builder.addPayment({ method: 'cash', amountMinor: 3500 });
  return { ...finalizeOrder(builder.getSnapshot()), syncStatus: 'applied' };
}

describe('orderStatusBadge', () => {
  it('gives TallyUI\'s badge key for each Medusa status the Orders filter uses', () => {
    const order = sale();
    expect(orderStatusBadge({ ...order, syncStatus: 'applied' })).toBe('completed');
    expect(orderStatusBadge({ ...order, syncStatus: 'pending' })).toBe('pending');
    expect(orderStatusBadge({ ...order, syncStatus: 'rejected' })).toBe('cancelled');
  });
});

describe('orderDetailFigures', () => {
  it('takes every figure from TallyUI\'s receipt builder', () => {
    const order = sale();
    const receipt = buildReceiptDataFromPosOrder(order, { storeName: '' });
    const figures = orderDetailFigures(order);
    expect(figures.lineItems.map(({ name, quantity }) => ({ name, quantity }))).toEqual([
      { name: 'Blue shirt', quantity: 1 }, { name: 'Red hat', quantity: 2 },
    ]);
    expect(figures.lineItems.map((line) => line.total)).toEqual(
      receipt.lineItems.map((line) => formatMoney({ amount: line.displayAmountMinor, currency: 'EUR' })));
    expect(receipt.totals.taxMinor).toBeGreaterThan(0);
    expect(figures.subtotal).toBe(formatMoney({ amount: receipt.totals.subtotalMinor, currency: 'EUR' }));
    expect(figures.tax).toBe(formatMoney({ amount: receipt.totals.taxMinor, currency: 'EUR' }));
    expect(figures.total).toBe(formatMoney({ amount: receipt.totals.totalMinor, currency: 'EUR' }));
    expect(figures.total).toBe(formatMoney({ amount: order.totalMinor, currency: 'EUR' }));
  });
});

describe('paymentLabel', () => {
  it('uses the words TallyUI\'s OrdersList uses', () => {
    expect(paymentLabel('cash')).toBe('Cash');
    expect(paymentLabel('external')).toBe('Card terminal');
  });
});

describe('canSyncOrder / syncOrder', () => {
  const rejected = (code: string): PosOrder => ({ ...sale(), syncStatus: 'rejected', error: { code, message: 'Refused' } });
  const outbox = () => ({ flush: vi.fn(async () => {}), requeue: vi.fn(async () => 1) });

  it('offers Sync for a pending sale and a rejection the outbox resends, never for an applied sale', () => {
    expect(canSyncOrder({ ...sale(), syncStatus: 'pending' })).toBe(true);
    expect(canSyncOrder(rejected('store_configuration'))).toBe(true);
    expect(canSyncOrder(rejected('idempotency_mismatch'))).toBe(false);
    expect(canSyncOrder(sale())).toBe(false);
  });

  it('flushes a pending sale', async () => {
    const calls = outbox();
    await syncOrder(calls, { ...sale(), syncStatus: 'pending' });
    expect(calls.flush).toHaveBeenCalledTimes(1);
    expect(calls.requeue).not.toHaveBeenCalled();
  });

  it('requeues a rejected sale by its id', async () => {
    const calls = outbox();
    const order = rejected('store_configuration');
    await syncOrder(calls, order);
    expect(calls.requeue).toHaveBeenCalledTimes(1);
    expect(calls.requeue).toHaveBeenCalledWith([order.id]);
    expect(calls.flush).not.toHaveBeenCalled();
  });

  it('does nothing for an applied sale', async () => {
    const calls = outbox();
    await syncOrder(calls, sale());
    expect(calls.flush).not.toHaveBeenCalled();
    expect(calls.requeue).not.toHaveBeenCalled();
  });
});
