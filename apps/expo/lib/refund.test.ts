import { describe, expect, it } from 'vitest';
import type { StoreOrder, StoreOrderLine } from '@tallyui/core';
import { priceRefund, refundableLines, type PosOrder } from '@tallyui/pos';
import type { RefundFormValue } from '@tallyui/components';
import { paymentLabel } from './order-detail';
import { refundFormInput, refundRequest } from './refund';

// 0.99 ex 19% splits the plugin's way (net = round(gross − tax)): net 99, tax 19, 1.18 a line.
const line = (id: string, extra: Partial<StoreOrderLine> = {}): StoreOrderLine => ({
  id, clientLineId: `client-${id}`, name: `Item ${id}`, quantity: 1, subtotalMinor: 99, subtotalTaxMinor: 19, totalMinor: 99, taxMinor: 19,
  soldTotalMinor: extra.totalMinor ?? 99, soldTaxMinor: extra.taxMinor ?? 19, ...extra,
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

const earlierLine = (orderLineId: string) => ({ orderLineId, quantity: 1, netMinor: 99, taxMinor: 19 });
const firstRefund = { id: 'r1', amountMinor: 118, lines: [earlierLine('a')] };
const formValue: RefundFormValue = {
  lines: threeLines().map(({ id }) => ({ orderLineId: id, quantity: 1, restock: true })),
  shippingMinor: 0, adjustmentMinor: -1, totalMinor: 353, destination: 'cash', reason: 'Returned',
};

describe('refundFormInput', () => {
  it('offers the signed difference between the payment and the three line shares', () => {
    const input = refundFormInput(order({ paid: 353 }), cash);
    expect(input).toMatchObject({ offered: true, remainderShareMinor: -1, orderTotalMinor: 353, refundedMinor: 0 });
    expect(input.offered && input.lines).toEqual(threeLines());
    expect(refundFormInput(order({ paid: 355 }), cash)).toMatchObject({ offered: true, remainderShareMinor: 1 });
  });

  it('subtracts earlier line money before assigning the remainder to the remaining lines', () => {
    expect(refundFormInput(order({ paid: 353, refunds: [firstRefund] }), cash)).toMatchObject({
      offered: true, refundedMinor: 118, remainderShareMinor: -1, refunds: [{ lines: firstRefund.lines }],
    });
    const second = { id: 'r2', amountMinor: 118, lines: [earlierLine('b')] };
    expect(refundFormInput(order({ paid: 353, refunds: [firstRefund, second] }), cash))
      .toMatchObject({ offered: true, refundedMinor: 236, remainderShareMinor: -1 });
  });

  it('prices the remaining units of a partially refunded line', () => {
    const lines = [line('a', { quantity: 3, totalMinor: 297, taxMinor: 57 })];
    const double = { id: 'r1', amountMinor: 236, lines: [{ orderLineId: 'a', quantity: 2, netMinor: 198, taxMinor: 38 }] };
    for (const refunds of [[], [double], [firstRefund, { ...firstRefund, id: 'r2' }]]) {
      expect(refundFormInput(order({ paid: 353, lines, refunds }), cash)).toMatchObject({ offered: true, remainderShareMinor: -1 });
    }
  });

  it('refuses drift greater than one minor unit per line', () => {
    expect(refundFormInput(order({ paid: 360 }), cash)).toEqual({ offered: false, reason: 'money_drift' });
  });

  it('drops a negative difference unless the net or the largest gross line’s tax covers it', () => {
    const shipping = [{ name: 'Courier', totalMinor: 100, taxMinor: 0 }];
    const lines = ['a', 'b'].map(id => line(id, { totalMinor: 1, taxMinor: 0 }));
    expect(refundFormInput(order({ paid: 100, lines, shipping }), cash)).toMatchObject({ offered: true, remainderShareMinor: 0 });
    expect(refundFormInput(order({ paid: 101, lines: [line('a', { totalMinor: 0, taxMinor: 2 })], shipping }), cash))
      .toMatchObject({ offered: true, remainderShareMinor: -1 });
  });

  it('excludes both kinds of fees from the remainder and the form lines', () => {
    const lines = [...threeLines(), line('fee', { clientLineId: undefined, totalMinor: 50, taxMinor: 0 })];
    const fees = [{ name: 'Bag fee', totalMinor: 20, taxMinor: 0 }];
    const input = refundFormInput(order({ paid: 423, lines, fees }), cash);
    expect(input).toMatchObject({ offered: true, remainderShareMinor: -1 });
    expect(input.offered && input.lines).toEqual(threeLines());
  });

  it('reduces available shipping only by earlier amounts beyond the refunded lines', () => {
    const sale = { paid: 853, shipping: [{ name: 'Courier', totalMinor: 500, taxMinor: 0 }] };
    expect(refundFormInput(order(sale), cash)).toMatchObject({ offered: true, refundableShippingMinor: 500 });
    expect(refundFormInput(order({ ...sale, refunds: [{ ...firstRefund, amountMinor: 618 }] }), cash))
      .toMatchObject({ offered: true, refundableShippingMinor: 0 });
    expect(refundFormInput(order({ ...sale, refunds: [firstRefund] }), cash)).toMatchObject({ offered: true, refundableShippingMinor: 500 });
  });

  it('refuses an earlier refund whose lines are unknown', () => {
    expect(refundFormInput(order({ paid: 353, refunds: [{ id: 'r1', amountMinor: 353 }] }), cash))
      .toEqual({ offered: false, reason: 'lines_unknown' });
  });

  it('refuses canceled, unpaid, unreadable and fully refunded sales', () => {
    expect(refundFormInput(order({ paid: 353, status: 'canceled' }), cash)).toEqual({ offered: false, reason: 'canceled' });
    expect(refundFormInput(order({ paid: 353, payments: [] }), cash)).toEqual({ offered: false, reason: 'no_payment' });
    expect(refundFormInput(order({ paid: 353, paymentRecordUnreadable: true }), cash)).toEqual({ offered: false, reason: 'no_payment' });
    const refunds = [{ id: 'r1', amountMinor: 353, lines: threeLines().map(({ id }) => earlierLine(id)) }];
    expect(refundFormInput(order({ paid: 353, refunds }), cash)).toEqual({ offered: false, reason: 'refunded' });
  });

  it('omits the original method for cash and names each non-cash method once', () => {
    const sale = order({ paid: 353 });
    expect(refundFormInput(sale, cash)).not.toHaveProperty('originalMethod');
    for (const tenders of [card, [...cash, ...card, ...card]]) {
      expect(refundFormInput(sale, tenders)).toMatchObject({ offered: true, originalMethod: { title: paymentLabel('external'), available: true } });
    }
  });
});

describe('refundFormInput sold figures (#636)', () => {
  const tillRefund = (netMinor: number, taxMinor: number) => ({ id: 'r1', amountMinor: netMinor + taxMinor,
    lines: [{ orderLineId: 'a', quantity: 1, netMinor, taxMinor }] });
  const shrunk = line('a', { quantity: 2, totalMinor: 250, taxMinor: 0, soldTotalMinor: 500, soldTaxMinor: 0, returnedQuantity: 1 });
  const half = tillRefund(250, 0);
  const first = tillRefund(33, 6);
  const thirds = (returnedQuantity: number) => line('a', { quantity: 3, soldTotalMinor: 100, soldTaxMinor: 19, returnedQuantity,
    totalMinor: [100, 67, 33][returnedQuantity], taxMinor: [19, 13, 6][returnedQuantity] });
  const extra = { lines: [{ orderLineId: 'a', quantity: 1 }] };
  const take = (quantity: number) => [{ orderLineId: 'a', quantity, restock: true }];

  it('S1: prices the remaining half from the sold figures without counting the till return twice', () => {
    expect(refundFormInput(order({ paid: 500, lines: [shrunk], refunds: [half] }), cash))
      .toMatchObject({ offered: true, remainderShareMinor: 0, refunds: [{ lines: half.lines }] });
  });

  it('S2: refuses when any product line lacks either sold figure', () => {
    for (const missing of [{ soldTotalMinor: undefined }, { soldTaxMinor: undefined }, { soldTotalMinor: undefined, soldTaxMinor: undefined }]) {
      const lines = [line('b', { totalMinor: 0, taxMinor: 0 }), { ...shrunk, ...missing }];
      expect(refundFormInput(order({ paid: 500, lines, refunds: [half] }), cash)).toEqual({ offered: false, reason: 'sold_unknown' });
    }
  });

  it('S3: an admin return advances the sold-price shares but is not till refund money', () => {
    const input = refundFormInput(order({ paid: 119, lines: [thirds(1)] }), cash);
    expect(input).toMatchObject({ offered: true, refundedMinor: 0, remainderShareMinor: 0, refunds: [extra] });
    expect(input.offered && refundableLines(input.lines, input.refunds)).toMatchObject([{ refundableQuantity: 2 }]);
    expect(input.offered && priceRefund(input.lines, input.refunds, take(2)).totalMinor).toBe(80);
  });

  it.each([['S4', 1], ['S5', 0]] as const)('%s: the last two units qualify for rounding after a till refund (returnedQuantity %i)', (_, returned) => {
    for (const paid of [119, 118]) {
      const input = refundFormInput(order({ paid, lines: [thirds(returned)], refunds: [first] }), cash);
      expect(input).toMatchObject({ offered: true, remainderShareMinor: paid - 119, refunds: [{ lines: first.lines }] });
      expect(input.offered && refundableLines(input.lines, input.refunds)).toMatchObject([{ refundableQuantity: 2 }]);
      expect(input.offered && priceRefund(input.lines, input.refunds, take(2)).totalMinor).toBe(80);
    }
  });

  it('S6: counts only the extra admin return and does not charge its money to shipping', () => {
    for (const shippingMinor of [0, 500]) {
      const input = refundFormInput(order({ paid: 119 + shippingMinor, lines: [thirds(2)], refunds: [first],
        shipping: shippingMinor ? [{ name: 'Courier', totalMinor: shippingMinor, taxMinor: 0 }] : [] }), cash);
      expect(input).toMatchObject({ offered: true, refunds: [{ lines: first.lines }, extra], refundedMinor: 39,
        remainderShareMinor: 0, refundableShippingMinor: shippingMinor });
      expect(input.offered && refundableLines(input.lines, input.refunds)).toMatchObject([{ refundableQuantity: 1 }]);
      expect(input.offered && priceRefund(input.lines, input.refunds, take(1)).totalMinor).toBe(39);
    }
  });

  it('S7: taking both available units after an admin return leaves the request unchanged', () => {
    const input = refundFormInput(order({ paid: 119, lines: [thirds(1)] }), cash);
    const value = { ...formValue, lines: take(2), totalMinor: 80, adjustmentMinor: 0 };
    expect(input.offered && refundRequest(value, input)).toBe(value);
  });
});

describe('refundRequest', () => {
  it('removes the remainder from the adjustment but keeps the form total', () => {
    const input = refundFormInput(order({ paid: 353 }), cash);
    expect(input.offered && refundRequest(formValue, input)).toEqual({ ...formValue, adjustmentMinor: 0, totalMinor: 353 });
  });

  it('only removes the share when every remaining line is taken', () => {
    const input = refundFormInput(order({ paid: 353, refunds: [firstRefund] }), cash);
    const both = { ...formValue, lines: formValue.lines.slice(1), totalMinor: 235 };
    const onlyB = { ...both, lines: both.lines.slice(0, 1), adjustmentMinor: 0, totalMinor: 118 };
    expect(input.offered && refundRequest(onlyB, input)).toBe(onlyB);
    expect(input.offered && refundRequest(both, input)).toEqual({ ...both, adjustmentMinor: 0 });
  });

  it('preserves a partial request and an emptying request with no share', () => {
    const input = refundFormInput(order({ paid: 353 }), cash);
    const partial = { ...formValue, lines: formValue.lines.slice(0, 2), adjustmentMinor: 0, totalMinor: 236 };
    expect(input.offered && refundRequest(partial, input)).toBe(partial);
    const exact = refundFormInput(order({ paid: 354 }), cash);
    expect(exact.offered && refundRequest(formValue, exact)).toEqual(formValue);
  });
});
