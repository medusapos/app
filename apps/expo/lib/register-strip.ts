import type { DrawerTerms } from '@tallyui/pos';

export type StripChip = {
  key: 'float' | 'cash-sales' | 'cash-refunds' | 'paid-in' | 'paid-out';
  label: string; amountMinor: number; op: '+' | '−' | null;
};

export function registerStripEquation(terms: DrawerTerms): { chips: StripChip[]; expectedMinor: number } {
  const chips: StripChip[] = [
    { key: 'float', label: 'Opening float', amountMinor: terms.floatMinor, op: null },
    { key: 'cash-sales', label: `Cash sales · ${terms.cashSales.count}`, amountMinor: terms.cashSales.amountMinor, op: '+' },
  ];
  if (terms.cashRefunds.count > 0) chips.push({
    key: 'cash-refunds', label: `Cash refunds · ${terms.cashRefunds.count}`, amountMinor: terms.cashRefunds.amountMinor, op: '−',
  });
  if (terms.paidIn.count > 0) chips.push({
    key: 'paid-in', label: `Paid in · ${terms.paidIn.count}`, amountMinor: terms.paidIn.amountMinor, op: '+',
  });
  if (terms.paidOut.count > 0) chips.push({
    key: 'paid-out', label: `Paid out · ${terms.paidOut.count}`, amountMinor: terms.paidOut.amountMinor, op: '−',
  });
  return { chips, expectedMinor: terms.expected.cash ?? 0 };
}
