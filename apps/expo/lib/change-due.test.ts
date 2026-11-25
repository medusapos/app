import { describe, expect, it } from 'vitest';
import { createOrderBuilder } from '@tallyui/pos';
import { changeDueMinor } from './change-due';

// A 24.00 sale, its legs added as @tallyui/pos 5.0.0's addTender records them (use-sale.ts:961-993): a cash leg taken
// at Take holds the amount applied, with tenderedMinor the entry and changeMinor the rest.
function sale() {
  const builder = createOrderBuilder({ currency: 'EUR', taxContext: { pricesIncludeTax: false, getTaxRatePpm: () => 0 } });
  builder.addLine({ productId: 'shirt', variantId: 'blue', name: 'Blue shirt', unitPrice: { amount: 2400, currency: 'EUR' } });
  return builder;
}
const cash = (amountMinor: number, tenderedMinor: number) =>
  ({ method: 'cash', amountMinor, tenderedMinor, changeMinor: tenderedMinor - amountMinor });

describe('changeDueMinor', () => {
  it('C1 cash over the total: the leg carries the change', () => {
    const builder = sale();
    builder.addPayment(cash(2400, 3000));
    expect(builder.getSnapshot().changeDueMinor).toBe(0);
    expect(changeDueMinor(builder.getSnapshot())).toBe(600);
  });

  it('C2 exact cash: no change', () => {
    const builder = sale();
    builder.addPayment(cash(2400, 2400));
    expect(changeDueMinor(builder.getSnapshot())).toBe(0);
  });

  it('C3 split, card then cash over: the cash leg\'s change', () => {
    const builder = sale();
    builder.addPayment({ method: 'card', amountMinor: 1000 });
    builder.addPayment(cash(1400, 2000));
    expect(changeDueMinor(builder.getSnapshot())).toBe(600);
  });

  it('C4 two cash legs, the second over', () => {
    const builder = sale();
    builder.addPayment(cash(1000, 1000));
    builder.addPayment(cash(1400, 2000));
    expect(changeDueMinor(builder.getSnapshot())).toBe(600);
  });

  it('C5 tender swap: a voided cash leg\'s change is gone once card pays the whole total', () => {
    const builder = sale();
    const leg = builder.addPayment(cash(2400, 3000));
    expect(builder.setPaymentStatus(leg, 'voided')).toBe(true);
    builder.addPayment({ method: 'card', amountMinor: 2400 });
    expect(changeDueMinor(builder.getSnapshot())).toBe(0);
  });

  it('C6 a voided cash leg with change, then a new cash leg: only the new leg\'s change', () => {
    const builder = sale();
    const leg = builder.addPayment(cash(2400, 3000));
    expect(builder.setPaymentStatus(leg, 'voided')).toBe(true);
    builder.addPayment(cash(2400, 2500));
    expect(changeDueMinor(builder.getSnapshot())).toBe(100);
  });

  it('C7 an un-netted leg (a 4.2.0 draft): the overpayment is change', () => {
    const builder = sale();
    builder.addPayment({ method: 'cash', amountMinor: 3000 });
    expect(changeDueMinor(builder.getSnapshot())).toBe(600);
  });

  it('C8 reopened sale: locked legs beyond the total are the store\'s refund due, not change', () => {
    const builder = sale();
    builder.addPayment({ method: 'cash', amountMinor: 3000, locked: true, storePaymentId: 'pay_1' });
    expect(builder.getSnapshot().changeDueMinor).toBe(600);
    expect(changeDueMinor(builder.getSnapshot())).toBe(0);
  });

  it('C9 reopened sale: a locked leg\'s own changeMinor is never till change', () => {
    const builder = sale();
    builder.addPayment({ ...cash(2400, 3000), locked: true, storePaymentId: 'pay_1' });
    expect(changeDueMinor(builder.getSnapshot())).toBe(0);
  });

  it('C10 a failed or pending cash leg carrying changeMinor: no change', () => {
    for (const status of ['failed', 'pending'] as const) {
      const builder = sale();
      builder.addPayment({ ...cash(2400, 3000), status });
      expect(changeDueMinor(builder.getSnapshot())).toBe(0);
    }
  });

  it('C11 card only, and no payments at all: no change', () => {
    const card = sale();
    card.addPayment({ method: 'card', amountMinor: 2400 });
    expect(changeDueMinor(card.getSnapshot())).toBe(0);
    expect(changeDueMinor(sale().getSnapshot())).toBe(0);
  });
});
