// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { formatClosureDate } from '@tallyui/pos';
import { ClosureTable } from '../components/closure-table';
import { closureContext } from '../components/register-close';
import type { ClosureTableRow } from '../lib/reports';

vi.mock('expo-localization', () => ({ getLocales: () => [{ languageTag: 'en-GB' }] }));
// react-native-web reads the window size from document.documentElement.clientWidth, which jsdom leaves at 0,
// so the width is set here rather than through window.innerWidth.
const viewport = vi.hoisted(() => ({ width: 1024 }));
vi.mock('react-native', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-native')>(),
  useWindowDimensions: () => ({ width: viewport.width, height: 768, scale: 1, fontScale: 1 }),
}));

const ctx = closureContext('EUR', { name: 'Test shop' });
const time = (value: string) => formatClosureDate(value, { timezone: ctx.timezone, locale: ctx.locale }).time;
const base = { registerName: 'Register 1', cashierName: 'Ana', salesMinor: 4500 };
const rows: ClosureTableRow[] = [
  { ...base, id: 'c12', number: 12, day: '2026-11-10', openedAt: '2026-11-10T02:40:00Z', closedAt: '2026-11-10T07:43:00Z',
    countedMinor: 4500, varianceMinor: 0 },
  { ...base, id: 'c11', number: 11, day: '2026-11-10', openedAt: '2026-11-10T01:00:00Z', closedAt: '2026-11-10T02:30:00Z',
    countedMinor: 4400, varianceMinor: -9000 },
  { ...base, id: 'c10', number: 10, day: '2026-11-09', openedAt: '2026-11-09T09:00:00Z', closedAt: '2026-11-09T18:00:00Z',
    cashierName: '—', countedMinor: null, varianceMinor: null },
];
const onOpen = vi.fn();
const mount = () => render(<ClosureTable rows={rows} ctx={ctx} testID="closures" rowTestID={(id) => `row-${id}`}
  today="2026-11-10" onOpen={onOpen} openable={(id) => id !== 'c11'} />);

afterEach(() => { cleanup(); onOpen.mockReset(); viewport.width = 1024; });

it('shows each closure as a two-line row with the counted total and the result at the right', () => {
  mount();
  const row = within(screen.getByTestId('row-c12'));
  expect(row.getByTestId('row-c12-title').textContent).toBe('Closure 12 · Register 1');
  expect(row.getByTestId('row-c12-detail').textContent).toBe(`${time(rows[0].openedAt)} → ${time(rows[0].closedAt)} · Ana`);
  expect(row.getByTestId('row-c12-cashier').textContent).toBe('Ana');
  expect(row.getByTestId('row-c12-counted').textContent).toBe(ctx.formatMoney('45.00'));
  expect(row.getByTestId('row-c12-variance').textContent).toBe('Exact');
  expect(screen.getByTestId('row-c11-variance').textContent).toBe(`${ctx.formatMoney('90.00')} short`);
  expect(screen.getByTestId('row-c10-counted').textContent).toBe('—');
  expect(screen.getByTestId('row-c10-variance').textContent).toBe('—');
  expect(screen.getByTestId('row-c10-cashier').textContent).toBe('—');
});

it('has no column header and none of the old table cells', () => {
  mount();
  const table = within(screen.getByTestId('closures'));
  for (const label of ['Closed', 'Sales']) expect(table.queryByText(label)).toBeNull();
  for (const cell of ['sales', 'closed', 'number', 'register']) expect(screen.queryByTestId(`row-c12-${cell}`)).toBeNull();
});

it('keeps the day group rows with their labels and totals', () => {
  mount();
  expect(screen.getByTestId('closures-day-2026-11-10-label').textContent).toBe('Today');
  expect(screen.getByTestId('closures-day-2026-11-10-total')).toBeTruthy();
  expect(screen.getByTestId('closures-day-2026-11-09-label').textContent).toBe('Yesterday');
  expect(screen.getByTestId('closures-day-2026-11-09')).toBeTruthy();
});

it('opens an openable row and gives a refused row no press', () => {
  mount();
  fireEvent.click(screen.getByTestId('row-c12-open'));
  expect(onOpen).toHaveBeenCalledWith('c12');
  expect(screen.queryByTestId('row-c11-open')).toBeNull();
});

it('stacks the counted total above the result in one cell on a phone', () => {
  mount();
  expect(screen.getByTestId('row-c12-counted').parentElement).not.toBe(screen.getByTestId('row-c12-variance').parentElement);
  cleanup();
  viewport.width = 360;
  mount();
  const counted = screen.getByTestId('row-c12-counted');
  expect(counted.parentElement).toBe(screen.getByTestId('row-c12-variance').parentElement);
  expect(counted.parentElement?.getAttribute('role')).toBe('cell');
});
