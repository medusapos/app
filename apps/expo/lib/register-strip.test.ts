import { describe, expect, it } from 'vitest';
import type { DrawerTerms } from '@tallyui/pos';
import { registerStripEquation } from './register-strip';

const terms: DrawerTerms = {
  floatMinor: 10000, cashSales: { amountMinor: 4500, count: 3 },
  cashRefunds: { amountMinor: 0, count: 0 }, paidIn: { amountMinor: 0, count: 0 },
  paidOut: { amountMinor: 0, count: 0 }, noSales: 0, otherTenders: {}, sessionSalesMinor: 4500,
  expected: { cash: 14500 },
};

describe('registerStripEquation', () => {
  it('shows the float and cash sales, omitting unused terms', () => {
    expect(registerStripEquation(terms)).toEqual({
      chips: [
        { key: 'float', label: 'Opening float', amountMinor: 10000, op: null },
        { key: 'cash-sales', label: 'Cash sales · 3', amountMinor: 4500, op: '+' },
      ],
      expectedMinor: 14500,
    });
  });

  it('includes refunds, paid in and paid out in equation order with their counts', () => {
    const result = registerStripEquation({ ...terms,
      cashRefunds: { amountMinor: 1250, count: 1 }, paidIn: { amountMinor: 500, count: 1 },
      paidOut: { amountMinor: 200, count: 2 }, expected: { cash: 13550 },
    });
    expect(result.chips).toEqual([
      { key: 'float', label: 'Opening float', amountMinor: 10000, op: null },
      { key: 'cash-sales', label: 'Cash sales · 3', amountMinor: 4500, op: '+' },
      { key: 'cash-refunds', label: 'Cash refunds · 1', amountMinor: 1250, op: '−' },
      { key: 'paid-in', label: 'Paid in · 1', amountMinor: 500, op: '+' },
      { key: 'paid-out', label: 'Paid out · 2', amountMinor: 200, op: '−' },
    ]);
  });

  it('uses expected cash directly even when it differs from the chips, or zero when missing', () => {
    expect(registerStripEquation({ ...terms, expected: { cash: 99999 } }).expectedMinor).toBe(99999);
    expect(registerStripEquation({ ...terms, expected: {} }).expectedMinor).toBe(0);
  });
});
