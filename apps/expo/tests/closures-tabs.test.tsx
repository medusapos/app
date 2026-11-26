// @vitest-environment jsdom
// @ts-expect-error no @types/react-dom in this Expo/React Native app
import { createPortal } from 'react-dom';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PortalHost } from '@tallyui/primitives';
import type { Closure } from '@tallyui/pos';
import ReportsScreen from '../app/reports';
import { closureContext } from '../components/register-close';
import { dayBefore } from '../lib/closure-history';
import { printXReport } from '../lib/closure-print';
import { openOrderStore, closeOrderStores, registerCollections } from '../lib/order-store';
import { useOutboxContext } from '../lib/outbox-context';
import { useRegister } from '../lib/register-context';
import { localDay } from '../lib/reports';
import { saveSession } from '../lib/session';
import { SessionProvider } from '../lib/session-context';
import { saveCachedSettings } from '../lib/store-settings';

vi.mock('expo-localization', () => ({ getLocales: () => [{ languageTag: 'en-GB' }] }));
vi.mock('expo-router', () => ({
  Redirect: ({ href }: { href: string }) => <span>redirect:{href}</span>,
  router: { replace: vi.fn(), back: vi.fn(), push: vi.fn(), canGoBack: vi.fn(() => false) }, usePathname: () => '/reports',
  Stack: { Screen: ({ options }: { options: { title?: string; headerShown?: boolean; headerLeft?: () => ReactNode; headerRight?: () => ReactNode } }) =>
    <><div data-testid="header-left" data-header-shown={String(options.headerShown)} data-title={options.title}>
      {options.headerLeft?.()}</div>
      {createPortal(<div data-testid="header-right">{options.headerShown && options.headerRight?.()}</div>, document.body)}</> },
}));
vi.mock('../lib/outbox-context', () => ({ useOutboxContext: vi.fn() }));
vi.mock('../lib/register-context', () => ({ useRegister: vi.fn() }));
vi.mock('../lib/reports', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/reports')>(), downloadCsv: vi.fn(),
}));
vi.mock('../lib/closure-print', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/closure-print')>(), printXReport: vi.fn(),
}));

const session = { id: 's1', register_id: 'register-1', status: 'open', opened_at_gmt: '2026-09-11T08:00:00Z',
  opened_by: 'ana@store.test', expected_float_minor: 1000, counted_float_minor: 1000, opening_variance_minor: 0 };

let n = 0;
let baseUrl: string;
let store: Awaited<ReturnType<typeof openOrderStore>>;
beforeEach(async () => {
  baseUrl = `https://closures-tabs-${++n}.test`;
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  });
  // Earlier closures read the store's list; Today never asks for it, and any ask finds nothing.
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ closures: [], more: false }))));
  saveCachedSettings(localStorage, baseUrl, {
    storeName: 'Test shop', currency: 'EUR', location: { id: 'loc', name: 'Main', countryCode: 'IE' },
  });
  store = await openOrderStore(baseUrl);
  vi.mocked(useOutboxContext).mockReturnValue({
    orders: store.orders, state: { pending: 0, sending: false }, recent: [], savesInFlight: 0, stuckCommandIds: [],
    record: vi.fn().mockResolvedValue(undefined), flush: vi.fn().mockResolvedValue(undefined),
    requeue: vi.fn().mockResolvedValue(0), discard: vi.fn(), cancelOnStore: vi.fn(), payRestOnStore: vi.fn(), reverseOnStore: vi.fn(), isStored: vi.fn().mockResolvedValue(false),
  });
  openRegister();
});
afterEach(async () => { cleanup(); await closeOrderStores(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

function openRegister(live: typeof session | null = session) {
  vi.mocked(useRegister).mockReturnValue({ boundRegisterId: 'register-1',
    registers: [{ id: 'register-1', name: 'Register 1' }], registerName: 'Register 1',
    register: { session: live && { ...live, store_key: baseUrl }, expected: { cash: 4000 }, salesCount: 2, movements: [],
      terms: { floatMinor: 1000, cashSales: { amountMinor: 3000, count: 2 }, cashRefunds: { amountMinor: 0, count: 0 },
        paidIn: { amountMinor: 0, count: 0 }, paidOut: { amountMinor: 0, count: 0 }, noSales: 0, otherTenders: {},
        sessionSalesMinor: 3000, expected: { cash: 4000 } }, blind: false, lastClosure: null },
  } as unknown as ReturnType<typeof useRegister>);
}
function closure(overrides: Partial<Closure> = {}): Closure {
  return {
    id: 'c1', session_id: 'session-1', register_id: 'register-1', store_key: baseUrl, business_day: localDay(new Date()), number: 1,
    opened_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), closed_at: new Date().toISOString(),
    till_expected: { cash: 1000 }, expected: { cash: 1000 }, counted: { cash: 1000 }, variance: { cash: 0 },
    period_sales_total_minor: 1000, period_refunds_total_minor: 0, perpetual_sales_total_minor: 1000, perpetual_refunds_total_minor: 0,
    unsynced_count: 0, unsynced_total_minor: 0, software_version: 'test', breakdowns: {},
    order_ids: [], movement_ids: [], print_count: 0, ...overrides,
  };
}
async function mountClosures() {
  saveSession(localStorage, { baseUrl, email: 'admin@store.test', token: 'token' });
  render(<SessionProvider><ReportsScreen /><PortalHost /></SessionProvider>);
  fireEvent.click(await screen.findByTestId('register-strip-open-closures'));
  await screen.findByTestId('closures-view');
}
const follows = (first: HTMLElement, second: HTMLElement) =>
  !!(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);

describe('Closures tabs and the open session row', () => {
  it('All lists the open session under Today, ahead of today\'s closures, and counts both', async () => {
    await registerCollections(store.orders).closures.insert(closure());
    await mountClosures();
    const row = await screen.findByTestId('closure-row-c1');
    expect(screen.getByTestId('closures-tab-all').getAttribute('aria-pressed')).toBe('true');
    const table = screen.getByTestId('closures-table');
    const open = within(table).getByTestId('closures-open-session');
    expect(follows(within(table).getByTestId(`closures-table-day-${localDay(new Date())}`), open)).toBe(true);
    expect(follows(open, row)).toBe(true);
    expect(screen.getByTestId('closures-open-session-title').textContent).toContain('Open · Register 1');
    expect(screen.getByTestId('closures-open-session-detail').textContent).toContain('since ');
    expect(screen.getByTestId('closures-open-session-detail').textContent).toContain(' · ana@store.test · 2 sales');
    const { formatMoney } = closureContext('EUR', { name: 'Test shop' });
    expect(screen.getByTestId('closures-open-session-expected').textContent).toBe(formatMoney('40.00'));
    expect(screen.getByTestId('closures-count').textContent).toBe('2 sessions');
    expect(follows(screen.getByTestId('closures-filters'), screen.getByTestId('closures-tabs'))).toBe(true);
    expect(follows(screen.getByTestId('closures-tabs'), table)).toBe(true);
  });

  it('Open shows only the open session, without Export CSV or earlier closures', async () => {
    await registerCollections(store.orders).closures.insert(closure());
    await mountClosures();
    await screen.findByTestId('closure-row-c1');
    fireEvent.click(screen.getByTestId('closures-tab-open'));
    await waitFor(() => expect(screen.queryByTestId('closure-row-c1')).toBeNull());
    expect(screen.getByTestId('closures-open-session')).toBeTruthy();
    expect(screen.getByTestId('closures-tab-open').getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByTestId('closures-export')).toBeNull();
    expect(screen.queryByTestId('earlier-closures-heading')).toBeNull();
    expect(screen.queryByTestId('earlier-closures-table')).toBeNull();
    expect(screen.getByTestId('closures-count').textContent).toBe('1 session');
  });

  it('Open hides earlier closures even over a period that covers earlier days', async () => {
    const [today, yesterday] = [localDay(new Date()), dayBefore(localDay(new Date()))];
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ closures: [{ closureId: 'h7', number: 7,
      businessDay: yesterday, openedAt: new Date(Date.now() - 26 * 3600e3).toISOString(),
      closedAt: new Date(Date.now() - 24 * 3600e3).toISOString(), periodSalesTotalMinor: 900 }], more: false }))));
    await mountClosures();
    fireEvent.click(screen.getByTestId('closures-period'));
    const day = (d: string) => screen.queryByTestId(`closures-period-calendar-day-${d}`);
    if (!day(yesterday)) fireEvent.click(screen.getByTestId('closures-period-calendar-prev'));
    fireEvent.click(day(yesterday)!);
    if (!day(today)) fireEvent.click(screen.getByTestId('closures-period-calendar-next'));
    fireEvent.click(day(today)!);
    fireEvent.click(screen.getByTestId('closures-period-apply'));
    expect(within(await screen.findByTestId('earlier-closures-table')).getByTestId('earlier-closure-h7')).toBeTruthy();
    expect(screen.getByTestId('earlier-closures-heading')).toBeTruthy();
    fireEvent.click(screen.getByTestId('closures-tab-open'));
    await waitFor(() => expect(screen.queryByTestId('earlier-closures-table')).toBeNull());
    for (const id of ['heading', 'loading', 'more', 'empty', 'error']) expect(screen.queryByTestId(`earlier-closures-${id}`)).toBeNull();
    expect(screen.getByTestId('closures-open-session')).toBeTruthy();
    expect(screen.getByTestId('closures-count').textContent).toBe('1 session');
  });

  it('Closed shows only the closures, with Export CSV', async () => {
    await registerCollections(store.orders).closures.insert(closure());
    await mountClosures();
    await screen.findByTestId('closure-row-c1');
    fireEvent.click(screen.getByTestId('closures-tab-closed'));
    await waitFor(() => expect(screen.queryByTestId('closures-open-session')).toBeNull());
    expect(screen.getByTestId('closure-row-c1')).toBeTruthy();
    expect(screen.getByTestId('closures-export')).toBeTruthy();
    expect(screen.getByTestId('closures-count').textContent).toBe('1 session');
  });

  it('with no closure today, All still shows the open session under its own Today header', async () => {
    await mountClosures();
    const open = await screen.findByTestId('closures-open-session');
    const day = `closures-table-day-${localDay(new Date())}`;
    expect(screen.getByTestId(`${day}-label`).textContent).toBe('Today');
    expect(screen.queryByTestId(`${day}-total`)).toBeNull();
    expect(follows(screen.getByTestId(day), open)).toBe(true);
    expect(screen.queryByTestId('closures-empty')).toBeNull();
    expect(screen.getByTestId('closures-count').textContent).toBe('1 session');
  });

  it('without an open session All has no session row, and Open says so', async () => {
    openRegister(null);
    await registerCollections(store.orders).closures.insert(closure());
    await mountClosures();
    await screen.findByTestId('closure-row-c1');
    expect(screen.queryByTestId('closures-open-session')).toBeNull();
    fireEvent.click(screen.getByTestId('closures-tab-open'));
    expect((await screen.findByTestId('closures-open-empty')).textContent).toBe('No open session');
    expect(screen.getByTestId('closures-count').textContent).toBe('0 sessions');
  });

  it('Print X-report prints the open session, and a failed print shows its message', async () => {
    vi.mocked(printXReport).mockResolvedValueOnce(undefined);
    await mountClosures();
    fireEvent.click(await screen.findByTestId('closures-open-session-print'));
    await waitFor(() => expect(printXReport).toHaveBeenCalledTimes(1));
    expect(vi.mocked(printXReport).mock.calls[0][0]).toMatchObject({ session: { id: 's1', status: 'open' },
      expected: { cash: 4000 }, salesCount: 2, registerName: 'Register 1' });
    await waitFor(() => expect(screen.getByTestId('closures-open-session-print').textContent).toContain('Print X-report'));
    vi.mocked(printXReport).mockRejectedValueOnce(new Error('Printer is offline'));
    fireEvent.click(screen.getByTestId('closures-open-session-print'));
    expect((await screen.findByTestId('closures-open-session-print-error')).textContent).toBe('Printer is offline');
    expect(within(screen.getByTestId('closures-open-session')).getByTestId('closures-open-session-print-error')).toBeTruthy();
  });

  it('a counting session shows Counting and offers no print', async () => {
    openRegister({ ...session, status: 'counting' });
    await mountClosures();
    expect((await screen.findByTestId('closures-open-session-title')).textContent).toContain('Counting · Register 1');
    expect(screen.queryByTestId('closures-open-session-print')).toBeNull();
  });

  it('choosing another cashier drops the open session opened by someone else', async () => {
    await registerCollections(store.orders).closures.insert(closure({ closed_by: 'user-2', breakdowns: { closed_by_name: 'Ben' } }));
    await mountClosures();
    await screen.findByTestId('closures-open-session');
    fireEvent.click(screen.getByTestId('closures-cashier'));
    fireEvent.click(screen.getByTestId('closures-cashier-option-user-2'));
    await waitFor(() => expect(screen.queryByTestId('closures-open-session')).toBeNull());
    expect(screen.getByTestId('closure-row-c1')).toBeTruthy();
    expect(screen.getByTestId('closures-count').textContent).toBe('1 session');
  });
});
