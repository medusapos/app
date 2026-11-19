import { describe, expect, it } from 'vitest';
import { reportCashierOptions } from './cashiers';

const sale = (cashierRef?: string) => ({ cashierRef }) as { cashierRef: string };
const me = { email: 'admin@store.test', name: 'Dana Cole' };

describe('reportCashierOptions', () => {
  it('lists each cashier found in the sales once, valued by the exact cashierRef', () => {
    expect(reportCashierOptions([sale('ben@store.test'), sale('ana@store.test'), sale('ben@store.test')], me, null))
      .toEqual([
        { value: 'ana@store.test', label: 'ana' }, { value: 'ben@store.test', label: 'ben' },
        { value: 'admin@store.test', label: 'Dana Cole' },
      ]);
  });

  it('lists the signed-in user with no sales, by name or else by their email\'s local part', () => {
    expect(reportCashierOptions([], me, null)).toEqual([{ value: 'admin@store.test', label: 'Dana Cole' }]);
    expect(reportCashierOptions([], { email: 'admin@store.test' }, null)).toEqual([{ value: 'admin@store.test', label: 'admin' }]);
    expect(reportCashierOptions([], { email: 'admin@store.test', name: '' }, null)).toEqual([{ value: 'admin@store.test', label: 'admin' }]);
  });

  it('labels the signed-in user by name even when their own sales are listed, and lists them once', () => {
    expect(reportCashierOptions([sale('admin@store.test'), sale('admin@store.test')], me, null))
      .toEqual([{ value: 'admin@store.test', label: 'Dana Cole' }]);
  });

  it('keeps the selected cashier when no sale in the range has them', () => {
    expect(reportCashierOptions([sale('ana@store.test')], me, 'ben@store.test')).toEqual([
      { value: 'ana@store.test', label: 'ana' }, { value: 'ben@store.test', label: 'ben' },
      { value: 'admin@store.test', label: 'Dana Cole' },
    ]);
    expect(reportCashierOptions([sale('ana@store.test')], me, 'ana@store.test').map((option) => option.value))
      .toEqual(['ana@store.test', 'admin@store.test']);
  });

  it('skips sales with an empty or missing cashierRef', () => {
    expect(reportCashierOptions([sale(''), sale(undefined), sale('ana@store.test')], { email: 'admin@store.test' }, null))
      .toEqual([{ value: 'admin@store.test', label: 'admin' }, { value: 'ana@store.test', label: 'ana' }]);
  });

  it('labels a ref with no @ by itself', () => {
    expect(reportCashierOptions([sale('till-7')], me, null)).toContainEqual({ value: 'till-7', label: 'till-7' });
  });

  it('sorts by label', () => {
    expect(reportCashierOptions([sale('zoe@store.test'), sale('Ben@store.test'), sale('ana@store.test')], me, null)
      .map((option) => option.label)).toEqual(['ana', 'Ben', 'Dana Cole', 'zoe']);
  });

  it('never shows an @ in a label', () => {
    const options = reportCashierOptions(
      [sale('ana@store.test'), sale('ben.ito@shop.example'), sale('till-7'), sale('@odd')],
      { email: 'admin@store.test', name: 'boss@store.test' }, 'cat@store.test');
    expect(options).toHaveLength(6);
    for (const option of options) expect(option.label).not.toContain('@');
  });
});
