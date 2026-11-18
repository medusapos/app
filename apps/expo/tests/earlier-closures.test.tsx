// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { formatClosureDate, type Closure } from '@tallyui/pos';
import { EarlierClosures } from '../components/earlier-closures';
import { closureContext } from '../components/register-close';
import { localDay } from '../lib/reports';

vi.mock('expo-localization', () => ({ getLocales: () => [{ languageTag: 'en-GB' }] }));

const session = { baseUrl: 'https://shop.test', email: 'a@b.c', token: 't0k' };
const ctx = closureContext('EUR', { name: 'Test shop' });
const first = { closureId: 'c12', number: 12, businessDay: '2026-11-09',
  openedAt: '2026-11-09T09:00:00Z', closedAt: '2026-11-09T18:00:00Z', periodSalesTotalMinor: 4500,
  closedBy: 'user-1', counted: { cash: 4400 }, tillExpected: { cash: 4500 } };
const second = { closureId: 'c11', number: 11, openedAt: '2026-11-08T09:00:00Z',
  closedAt: '2026-11-08T18:00:00Z', periodSalesTotalMinor: 2000 };
const third = { ...second, closureId: 'c10', number: 10 };
const fetchImpl = vi.fn<typeof fetch>();
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const mount = () => render(<EarlierClosures session={session} registerId="reg/1" today="2026-11-10" ctx={ctx}
  registerName="Register 1" cashierNames={{ 'user-1': 'Ana' }} />);
const rowIds = () => screen.getAllByTestId(/^earlier-closure-[^-]+$/).map((row) => row.getAttribute('data-testid'));

beforeEach(() => { fetchImpl.mockReset(); vi.stubGlobal('fetch', fetchImpl); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('lists earlier closures newest first and leaves out today', async () => {
  fetchImpl.mockResolvedValueOnce(response({ closures: [first, second], more: false }));
  mount();
  const row = within(await screen.findByTestId('earlier-closure-c12'));
  expect(rowIds()).toEqual(['earlier-closure-c12', 'earlier-closure-c11']);
  expect(row.getByTestId('earlier-closure-c12-number').textContent).toBe('#12');
  expect(row.getByTestId('earlier-closure-c12-closed').textContent)
    .toBe(formatClosureDate(first.closedAt, { timezone: ctx.timezone, locale: ctx.locale }).datetime);
  expect(row.getByTestId('earlier-closure-c12-register').textContent).toBe('Register 1');
  expect(row.getByTestId('earlier-closure-c12-cashier').textContent).toBe('Ana');
  expect(row.getByTestId('earlier-closure-c12-sales').textContent).toBe(ctx.formatMoney('45.00'));
  expect(row.getByTestId('earlier-closure-c12-counted').textContent).toBe(ctx.formatMoney('44.00'));
  expect(row.getByTestId('earlier-closure-c12-variance').textContent).toBe(`${ctx.formatMoney('1.00')} short`);
  expect(screen.getByTestId('earlier-closure-c11-counted').textContent).toBe('—');
  expect(screen.getByTestId('earlier-closure-c11-variance').textContent).toBe('—');
  expect(screen.getByTestId('earlier-closure-c11-cashier').textContent).toBe('—');
  expect(fetchImpl.mock.calls[0][0]).toContain('to=2026-11-09');
  expect(screen.queryByTestId('earlier-closures-more')).toBeNull();
});

it('Load more appends the next page before the last number', async () => {
  fetchImpl.mockResolvedValueOnce(response({ closures: [first, second], more: true }))
    .mockResolvedValueOnce(response({ closures: [third], more: false }));
  mount();
  fireEvent.click(await screen.findByTestId('earlier-closures-more'));
  await screen.findByTestId('earlier-closure-c10');
  expect(rowIds()).toEqual(['earlier-closure-c12', 'earlier-closure-c11', 'earlier-closure-c10']);
  expect(fetchImpl.mock.calls[1][0]).toContain('before=11');
  expect(screen.queryByTestId('earlier-closures-more')).toBeNull();
});

it('shows an empty state', async () => {
  fetchImpl.mockResolvedValueOnce(response({ closures: [], more: false }));
  mount();
  expect((await screen.findByTestId('earlier-closures-empty')).textContent).toBe('No earlier closures');
});

it('a failed load says why and Retry loads again', async () => {
  fetchImpl.mockResolvedValueOnce(response({}, 401))
    .mockResolvedValueOnce(response({ closures: [first], more: false }));
  mount();
  expect((await screen.findByTestId('earlier-closures-error')).textContent).toBe('Please sign in again.');
  expect(screen.queryAllByTestId(/^earlier-closure-[^-]+$/)).toHaveLength(0);
  fireEvent.click(screen.getByTestId('earlier-closures-retry'));
  await screen.findByTestId('earlier-closure-c12');
  expect(screen.queryByTestId('earlier-closures-error')).toBeNull();
});

it('a failed Load more keeps the rows shown', async () => {
  fetchImpl.mockResolvedValueOnce(response({ closures: [first], more: true })).mockResolvedValueOnce(response({}, 500));
  mount();
  fireEvent.click(await screen.findByTestId('earlier-closures-more'));
  expect((await screen.findByTestId('earlier-closures-error')).textContent).toBe("Couldn't load earlier closures.");
  expect(screen.getByTestId('earlier-closure-c12')).toBeTruthy();
});

const mountOpenable = (onOpen: (opened: { closure: Closure; frozen: boolean }) => void, localClosures?: Closure[]) =>
  render(<EarlierClosures session={session} registerId="reg/1" today="2026-11-10" ctx={ctx}
    registerName="Register 1" cashierNames={{ 'user-1': 'Ana' }} onOpen={onOpen} localClosures={localClosures} />);

it('groups rows by day under a header with the day\'s totals', async () => {
  fetchImpl.mockResolvedValueOnce(response({ closures: [first, second], more: false }));
  mount();
  expect((await screen.findByTestId('earlier-closures-table-day-2026-11-09-label')).textContent).toBe('Yesterday');
  expect(screen.getByTestId('earlier-closures-table-day-2026-11-09-total').textContent)
    .toBe(`${ctx.formatMoney('44.00')} counted · ${ctx.formatMoney('1.00')} short`);
  expect(screen.getByTestId(`earlier-closures-table-day-${localDay(new Date(second.closedAt))}`)).toBeTruthy();
});

it('a row with store figures opens a closure built from them', async () => {
  fetchImpl.mockResolvedValueOnce(response({ closures: [first, second], more: false }));
  const onOpen = vi.fn();
  mountOpenable(onOpen);
  fireEvent.click(await screen.findByTestId('earlier-closure-c12-open'));
  expect(onOpen).toHaveBeenCalledOnce();
  expect(onOpen.mock.calls[0][0]).toMatchObject({ frozen: false,
    closure: { number: 12, counted: { cash: 4400 }, expected: { cash: 4500 }, variance: { cash: -100 } } });
  expect(screen.getByTestId('earlier-closure-c11')).toBeTruthy();
  expect(screen.queryByTestId('earlier-closure-c11-open')).toBeNull();
});

it('a row the device closed opens the device\'s own closure', async () => {
  fetchImpl.mockResolvedValueOnce(response({ closures: [first], more: false }));
  const own: Closure = {
    id: 'local-12', session_id: 's', register_id: 'reg/1', business_day: '2026-11-09', number: 12,
    opened_at: first.openedAt, closed_at: first.closedAt, till_expected: { cash: 4500 }, expected: { cash: 4500 },
    counted: { cash: 4400 }, variance: { cash: -100 }, period_sales_total_minor: 4500, period_refunds_total_minor: 0,
    perpetual_sales_total_minor: 4500, perpetual_refunds_total_minor: 0, unsynced_count: 0, unsynced_total_minor: 0,
    software_version: 'test', breakdowns: {}, order_ids: [], movement_ids: [], server_closure_id: 'c12', print_count: 0,
  };
  const onOpen = vi.fn();
  mountOpenable(onOpen, [own]);
  fireEvent.click(await screen.findByTestId('earlier-closure-c12-open'));
  expect(onOpen).toHaveBeenCalledOnce();
  expect(onOpen).toHaveBeenCalledWith({ closure: own, frozen: true });
});

it('from and to reach the query', async () => {
  fetchImpl.mockResolvedValueOnce(response({ closures: [], more: false }));
  render(<EarlierClosures session={session} registerId="reg/1" today="2026-11-10" ctx={ctx}
    registerName="Register 1" cashierNames={{}} from="2026-11-01" to="2026-11-05" />);
  await screen.findByTestId('earlier-closures-empty');
  expect(fetchImpl.mock.calls[0][0]).toContain('from=2026-11-01');
  expect(fetchImpl.mock.calls[0][0]).toContain('to=2026-11-05');
});

it('a cashier shows only that cashier\'s rows and onCashiers gets the fetched cashiers', async () => {
  fetchImpl.mockResolvedValueOnce(response({ closures: [first, second], more: false }));
  const onCashiers = vi.fn();
  render(<EarlierClosures session={session} registerId="reg/1" today="2026-11-10" ctx={ctx}
    registerName="Register 1" cashierNames={{ 'user-1': 'Ana' }} cashierId="user-1" onCashiers={onCashiers} />);
  await screen.findByTestId('earlier-closure-c12');
  expect(rowIds()).toEqual(['earlier-closure-c12']);
  // The fetched cashiers are reported by an effect that runs after the rows render.
  await waitFor(() => expect(onCashiers).toHaveBeenLastCalledWith(['user-1']));
});

it('without a heading the empty text names the period', async () => {
  fetchImpl.mockResolvedValueOnce(response({ closures: [], more: false }));
  render(<EarlierClosures session={session} registerId="reg/1" today="2026-11-10" ctx={ctx}
    registerName="Register 1" cashierNames={{}} heading={null} />);
  expect((await screen.findByTestId('earlier-closures-empty')).textContent).toBe('No closures in this period');
  expect(screen.queryByTestId('earlier-closures-heading')).toBeNull();
});
