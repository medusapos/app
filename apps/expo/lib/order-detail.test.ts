import { describe, expect, it } from 'vitest';
import { formatMoney } from '@tallyui/core';
import { buildReceiptDataFromPosOrder, createOrderBuilder, finalizeOrder, type PosOrder } from '@tallyui/pos';
import { orderDetailFigures, orderStatusBadge, paymentLabel } from './order-detail';

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
