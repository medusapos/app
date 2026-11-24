import { describe, expect, it } from 'vitest';
import type { StoreOrder, StoreOrderLine } from '@tallyui/core';
import type { PosOrder } from '@tallyui/pos';
import { fullRefundOffer } from './refund';

// 0.99 ex 19% splits the plugin's way (net = round(gross − tax)): net 99, tax 19, 1.18 a line.
const line = (id: string, extra: Partial<StoreOrderLine> = {}): StoreOrderLine => ({
  id, clientLineId: `client-${id}`, name: `Item ${id}`, quantity: 1, subtotalMinor: 99, subtotalTaxMinor: 19, totalMinor: 99, taxMinor: 19, ...extra,
});
const threeLines = () => [line('a'), line('b'), line('c')];
function order(extra: Partial<StoreOrder> & { paid: number }): StoreOrder {
  const { paid, ...rest } = extra;
  return {
    id: 'order_1', reference: '1001', clientOrderId: 'sale-1', status: 'completed', placedAt: '2026-11-24T10:00:00Z', currency: 'EUR',
    pricesIncludeTax: false, customer: null, lines: threeLines(), fees: [], shipping: [], coupons: [], taxLines: [], discountMinor: 0,
    discountTaxMinor: 0, taxMinor: 57, totalMinor: paid, payments: [{ method: 'cash', amountMinor: paid }], refunds: [], ...rest,
  };
}
const cash: PosOrder['payments'] = [{ id: 'p1', method: 'cash', amountMinor: 353 }];
const card: PosOrder['payments'] = [{ id: 'p1', method: 'external', methodId: 'pp_card', amountMinor: 353 }];

describe('fullRefundOffer', () => {
  it('remainder 3.53', () => {
    const offer = fullRefundOffer(order({ paid: 353 }), cash, true);
    expect(offer).toMatchObject({ offered: true, totalMinor: 353, shippingMinor: 0, adjustmentMinor: 0 });
    expect(offer.offered && offer.lines).toEqual([
      { orderLineId: 'a', quantity: 1, restock: true }, { orderLineId: 'b', quantity: 1, restock: true }, { orderLineId: 'c', quantity: 1, restock: true },
    ]);
    expect(fullRefundOffer(order({ paid: 354 }), cash, false)).toMatchObject({ offered: true, totalMinor: 354, lines: [{ restock: false }, {}, {}] });
  });

  it('fee stays', () => {
    // The connector reads a fee item as a line without a till line id (#518 writes only tally_fee_uuid on it).
    const fee = { id: 'fee', clientLineId: undefined, name: 'Bag fee', quantity: 1, subtotalMinor: 100, subtotalTaxMinor: 19, totalMinor: 100, taxMinor: 19 };
    const offer = fullRefundOffer(order({ paid: 472, lines: [...threeLines(), fee] }), cash, true);
    expect(offer).toMatchObject({ offered: true, totalMinor: 353 });
    expect(offer.offered && offer.lines.map((entry) => entry.orderLineId)).toEqual(['a', 'b', 'c']);
    expect(fullRefundOffer(order({ paid: 472, fees: [{ name: 'Bag fee', totalMinor: 100, taxMinor: 19 }] }), cash, true))
      .toMatchObject({ offered: true, totalMinor: 353 });
  });

  it('shipping', () => {
    const offer = fullRefundOffer(order({ paid: 948, shipping: [{ name: 'Courier', totalMinor: 500, taxMinor: 95 }] }), cash, true);
    expect(offer).toMatchObject({ offered: true, shippingMinor: 595, totalMinor: 948 });
  });

  it('free line', () => {
    const free = line('free', { totalMinor: 0, taxMinor: 0, subtotalMinor: 0, subtotalTaxMinor: 0 });
    const offer = fullRefundOffer(order({ paid: 948, lines: [...threeLines(), free], shipping: [{ name: 'Courier', totalMinor: 500, taxMinor: 95 }] }), cash, true);
    expect(offer).toMatchObject({ offered: true, shippingMinor: 595, totalMinor: 353 + 595 });
    expect(offer.offered && offer.lines.map((entry) => entry.orderLineId)).toEqual(['a', 'b', 'c', 'free']);
  });

  it('money drift', () => {
    expect(fullRefundOffer(order({ paid: 351 }), cash, true)).toMatchObject({ offered: true, totalMinor: 351 });
    expect(fullRefundOffer(order({ paid: 350 }), cash, true)).toEqual({ offered: false, reason: 'money_drift' });
    expect(fullRefundOffer(order({ paid: 358 }), cash, true)).toEqual({ offered: false, reason: 'money_drift' });
  });

  it('already refunded', () => {
    expect(fullRefundOffer(order({ paid: 353, refunds: [{ id: 'refund_1', amountMinor: 100 }] }), cash, true)).toEqual({ offered: false, reason: 'refunded' });
  });

  it('nothing to refund', () => {
    const free = (id: string) => line(id, { totalMinor: 0, taxMinor: 0 });
    // Paid only for the fee: the lines' money is 0, and the fee stays.
    const fee = { name: 'Bag fee', totalMinor: 100, taxMinor: 19 };
    expect(fullRefundOffer(order({ paid: 119, lines: [free('a')], fees: [fee] }), cash, true)).toEqual({ offered: false, reason: 'nothing' });
    expect(fullRefundOffer(order({ paid: 0, payments: [] }), cash, true)).toEqual({ offered: false, reason: 'no_payment' });
    expect(fullRefundOffer(order({ paid: 0 }), cash, true)).toEqual({ offered: false, reason: 'no_payment' });
  });

  it('cash sale', () => {
    expect(fullRefundOffer(order({ paid: 353 }), cash, true)).toMatchObject({ offered: true, destination: 'cash', methodLabel: 'Cash' });
  });

  it('card sale', () => {
    expect(fullRefundOffer(order({ paid: 353 }), card, true))
      .toMatchObject({ offered: true, destination: 'original_method', methodLabel: 'Card terminal' });
  });

  it('split sale', () => {
    const split: PosOrder['payments'] = [{ id: 'p1', method: 'cash', amountMinor: 153 }, { id: 'p2', method: 'external', amountMinor: 200 }];
    // Both store payments count towards the remainder.
    const offer = fullRefundOffer(order({ paid: 353, payments: [{ method: 'cash', amountMinor: 153 }, { method: 'pp_card', amountMinor: 200 }] }), split, true);
    expect(offer).toMatchObject({ offered: true, totalMinor: 353, destination: 'original_method', methodLabel: 'Card terminal, then cash' });
  });

  it('canceled order', () => {
    expect(fullRefundOffer(order({ paid: 353, status: 'canceled' }), cash, true)).toEqual({ offered: false, reason: 'canceled' });
    // Checked first: a canceled order with an earlier refund still reads canceled.
    expect(fullRefundOffer(order({ paid: 353, status: 'canceled', refunds: [{ id: 'refund_1', amountMinor: 100 }] }), cash, true))
      .toEqual({ offered: false, reason: 'canceled' });
  });

  it('two shipping methods and a fee, each rounded on its own', () => {
    // Each charge's own rounded gross is summed in minor units, with no further rounding: 1190 + 2 × 121 + 121 = 1553 paid.
    const product = line('p', { subtotalMinor: 1000, subtotalTaxMinor: 190, totalMinor: 1000, taxMinor: 190 });
    const fee = { id: 'fee', clientLineId: undefined, name: 'Service fee', quantity: 1, subtotalMinor: 102, subtotalTaxMinor: 19, totalMinor: 102, taxMinor: 19 };
    const shipping = [{ name: 'Courier', totalMinor: 102, taxMinor: 19 }, { name: 'Express', totalMinor: 102, taxMinor: 19 }];
    const offer = fullRefundOffer(order({ paid: 1553, lines: [product, fee], shipping }), cash, true);
    expect(offer).toMatchObject({ offered: true, totalMinor: 1553 - 121, shippingMinor: 242 });
    expect(offer.offered && offer.lines.map((entry) => entry.orderLineId)).toEqual(['p']);
  });
});
