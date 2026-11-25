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

  it('already refunded (#547): Refund all at min(full, paid − refunds); nothing left is refunded', () => {
    const refunds = (...amounts: number[]) => amounts.map((amountMinor, index) => ({ id: `refund_${index}`, amountMinor }));
    // 0.01 goodwill on the 3.53 sale: all three lines at 352, the figure the plugin's clamp accepts.
    const goodwill = fullRefundOffer(order({ paid: 353, refunds: refunds(1) }), cash, true);
    expect(goodwill).toMatchObject({ offered: true, totalMinor: 352, shippingMinor: 0, adjustmentMinor: 0, methodLabel: 'Cash' });
    expect(goodwill.offered && goodwill.lines.map((entry) => entry.orderLineId)).toEqual(['a', 'b', 'c']);
    expect(fullRefundOffer(order({ paid: 353, refunds: refunds(100, 50) }), cash, true)).toMatchObject({ offered: true, totalMinor: 203 });
    // The min does not bind when the fee kept by the store is more than the refunds.
    const fee = { id: 'fee', clientLineId: undefined, name: 'Bag fee', quantity: 1, subtotalMinor: 100, subtotalTaxMinor: 19, totalMinor: 100, taxMinor: 19 };
    expect(fullRefundOffer(order({ paid: 472, lines: [...threeLines(), fee], refunds: refunds(1) }), cash, true)).toMatchObject({ offered: true, totalMinor: 353 });
    for (const taken of [refunds(353), refunds(200, 200)]) expect(fullRefundOffer(order({ paid: 353, refunds: taken }), cash, true)).toEqual({ offered: false, reason: 'refunded' });
  });

  it('U-569-1: goodwill bigger than the line money offers nothing; smaller goodwill is still offered', () => {
    const shipping = [{ name: 'Courier', totalMinor: 500, taxMinor: 95 }];
    // Lines 3 × 1.18 = 353, shipping 595 gross, paid 948. Refunds 400: overrun 948 − (948 − 400) = 400 > 353, refused.
    expect(fullRefundOffer(order({ paid: 948, shipping, refunds: [{ id: 'r1', amountMinor: 400 }] }), cash, true))
      .toEqual({ offered: false, reason: 'refunded' });
    // Refunds 300: overrun 300 <= 353, offered at min(948, 948 − 300) = 648.
    expect(fullRefundOffer(order({ paid: 948, shipping, refunds: [{ id: 'r1', amountMinor: 300 }] }), cash, true))
      .toMatchObject({ offered: true, totalMinor: 648 });
  });

  it('U-569-2: an overrun equal to the line money is offered; shipping-only with refunds is not', () => {
    const shipping = [{ name: 'Courier', totalMinor: 500, taxMinor: 95 }];
    // Refunds 353: overrun 353 = the line money 353, offered at min(948, 948 − 353) = 595.
    expect(fullRefundOffer(order({ paid: 948, shipping, refunds: [{ id: 'r1', amountMinor: 353 }] }), cash, true))
      .toMatchObject({ offered: true, totalMinor: 595 });
    // No product lines, shipping 595, paid 595, refunds 10: overrun 595 − 585 = 10 > line money 0, refused.
    expect(fullRefundOffer(order({ paid: 595, lines: [], shipping, refunds: [{ id: 'r1', amountMinor: 10 }] }), cash, true))
      .toEqual({ offered: false, reason: 'refunded' });
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

  it('split sale inside the card share', () => {
    // Cash 0.50 + card 2.00 with a 1.21 fee: the 1.29 refund fits on the card, so no cash leaves the drawer.
    const split: PosOrder['payments'] = [{ id: 'p1', method: 'cash', amountMinor: 50 }, { id: 'p2', method: 'external', amountMinor: 200 }];
    const product = line('p', { subtotalMinor: 108, subtotalTaxMinor: 21, totalMinor: 108, taxMinor: 21 });
    const fee = { id: 'fee', clientLineId: undefined, name: 'Service fee', quantity: 1, subtotalMinor: 102, subtotalTaxMinor: 19, totalMinor: 102, taxMinor: 19 };
    const payments = [{ method: 'cash', amountMinor: 50 }, { method: 'pp_card', amountMinor: 200 }];
    const offer = fullRefundOffer(order({ paid: 250, lines: [product, fee], payments }), split, true);
    expect(offer).toMatchObject({ offered: true, totalMinor: 129, destination: 'original_method', methodLabel: 'Card terminal' });
  });

  it('two non-cash methods', () => {
    // 'external' is the only non-cash wire method and paymentLabel names it 'Card terminal', so the label names it once.
    const two: PosOrder['payments'] = [
      { id: 'p1', method: 'external', methodId: 'pp_card', amountMinor: 200 }, { id: 'p2', method: 'external', methodId: 'pp_gift', amountMinor: 153 },
    ];
    expect(fullRefundOffer(order({ paid: 353 }), two, true))
      .toMatchObject({ offered: true, totalMinor: 353, destination: 'original_method', methodLabel: 'Card terminal' });
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
