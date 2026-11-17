// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PortalHost } from '@tallyui/primitives';
import { presetRange } from '@tallyui/pos';
import { ClosureFiltersBar } from '../components/closure-filters';
import type { ClosureFilters } from '../lib/reports';

vi.mock('expo-localization', () => ({ getLocales: () => [{ languageTag: 'en-GB' }] }));

const filters: ClosureFilters = { preset: 'today', range: presetRange('today', new Date(), 'device'), registerId: 'register-1', cashierId: null };
const registerOptions = [{ value: 'register-1', label: 'Test shop · Register 1' }, { value: 'register-2', label: 'Test shop · Register 2' }];
const cashierOptions = [{ value: 'user-1', label: 'Ana' }, { value: 'user-2', label: 'Ben' }];
const mount = (onChange = vi.fn(), value = filters) => {
  render(<><ClosureFiltersBar filters={value} onChange={onChange} registerOptions={registerOptions} cashierOptions={cashierOptions} /><PortalHost /></>);
  return onChange;
};

afterEach(cleanup);

it('shows the period and the chosen register\'s label', () => {
  mount();
  expect(screen.getByTestId('closures-filters')).toBeTruthy();
  expect(screen.getByTestId('closures-period').textContent).toMatch(/^Today · /);
  expect(screen.getByTestId('closures-register').textContent).toBe('Test shop · Register 1');
  expect(screen.getByTestId('closures-cashier').textContent).toBe('All cashiers');
});

it('a period preset calls onChange with that preset and range', async () => {
  const onChange = mount();
  fireEvent.click(screen.getByTestId('closures-period'));
  fireEvent.click(await screen.findByTestId('closures-period-yesterday'));
  expect(onChange).toHaveBeenCalledWith({ ...filters, preset: 'yesterday', range: presetRange('yesterday', new Date(), 'device') });
});

it('choosing a cashier sets cashierId and All cashiers clears it', () => {
  const onChange = mount();
  fireEvent.click(screen.getByTestId('closures-cashier'));
  fireEvent.click(screen.getByTestId('closures-cashier-option-user-2'));
  expect(onChange).toHaveBeenLastCalledWith({ ...filters, cashierId: 'user-2' });
  expect(screen.queryByTestId('closures-cashier-option-user-2')).toBeNull();
  cleanup();
  mount(onChange, { ...filters, cashierId: 'user-2' });
  expect(screen.getByTestId('closures-cashier').textContent).toBe('Ben');
  fireEvent.click(screen.getByTestId('closures-cashier'));
  fireEvent.click(screen.getByTestId('closures-cashier-option-all'));
  expect(onChange).toHaveBeenLastCalledWith({ ...filters, cashierId: null });
});

it('choosing a register sets registerId', () => {
  const onChange = mount();
  fireEvent.click(screen.getByTestId('closures-register'));
  fireEvent.click(screen.getByTestId('closures-register-option-register-2'));
  expect(onChange).toHaveBeenCalledWith({ ...filters, registerId: 'register-2' });
});
