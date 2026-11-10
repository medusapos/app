// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { formatClosureDate } from '@tallyui/pos';
import { EarlierClosures } from '../components/earlier-closures';
import { closureContext } from '../components/register-close';

vi.mock('expo-localization', () => ({ getLocales: () => [{ languageTag: 'en-GB' }] }));

const session = { baseUrl: 'https://shop.test', email: 'a@b.c', token: 't0k' };
const ctx = closureContext('EUR', { name: 'Test shop' });
const first = { closureId: 'c12', number: 12, businessDay: '2026-11-09',
  openedAt: '2026-11-09T09:00:00Z', closedAt: '2026-11-09T18:00:00Z', periodSalesTotalMinor: 4500 };
const second = { closureId: 'c11', number: 11, openedAt: '2026-11-08T09:00:00Z',
  closedAt: '2026-11-08T18:00:00Z', periodSalesTotalMinor: 2000 };
const third = { ...second, closureId: 'c10', number: 10 };
const fetchImpl = vi.fn<typeof fetch>();
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const mount = () => render(<EarlierClosures session={session} registerId="reg/1" today="2026-11-10" ctx={ctx} />);
const rowIds = () => screen.getAllByTestId(/^earlier-closure-/).map((row) => row.getAttribute('data-testid'));

beforeEach(() => { fetchImpl.mockReset(); vi.stubGlobal('fetch', fetchImpl); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('lists earlier closures newest first and leaves out today', async () => {
  fetchImpl.mockResolvedValueOnce(response({ closures: [first, second], more: false }));
  mount();
  const row = within(await screen.findByTestId('earlier-closure-c12'));
  expect(rowIds()).toEqual(['earlier-closure-c12', 'earlier-closure-c11']);
  expect(row.getByText('Closure #12')).toBeTruthy();
  expect(row.getByText('Day').nextElementSibling?.textContent).toBe('2026-11-09');
  expect(row.getByText('Sales').nextElementSibling?.textContent).toBe(ctx.formatMoney('45.00'));
  expect(row.getByText('Closed').nextElementSibling?.textContent)
    .toBe(formatClosureDate(first.closedAt, { timezone: ctx.timezone, locale: ctx.locale }).datetime);
  expect(within(screen.getByTestId('earlier-closure-c11')).getByText('Day').nextElementSibling?.textContent).toBe('2026-11-08');
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
  expect(screen.queryAllByTestId(/^earlier-closure-/)).toHaveLength(0);
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
