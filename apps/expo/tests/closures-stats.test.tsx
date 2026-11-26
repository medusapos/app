// @vitest-environment jsdom
// @ts-expect-error no @types/react-dom in this Expo/React Native app
import { createPortal } from 'react-dom';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PortalHost } from '@tallyui/primitives';
import type { Closure } from '@tallyui/pos';
import ReportsScreen from '../app/reports';
import { useFrameMenu } from '../components/app-frame';
import { closureContext } from '../components/register-close';
import { dayBefore } from '../lib/closure-history';
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
vi.mock('../components/app-frame', async (importOriginal) => ({
  ...await importOriginal<typeof import('../components/app-frame')>(), useFrameMenu: vi.fn(() => undefined),
}));
// react-native-web drops className without NativeWind, so the app's Text echoes it as data-class for the colour check.
vi.mock('../components/app-text', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../components/app-text')>();
  const { forwardRef } = await import('react');
  const AppText = forwardRef<never, Parameters<typeof actual.AppText>[0]>((props, ref) =>
    <actual.AppText ref={ref} {...props} {...{ dataSet: { class: props.className } }} />);
  return { ...actual, AppText };
});

const session = { id: 's1', register_id: 'register-1', status: 'open', opened_at_gmt: '2026-09-11T08:00:00Z',
  opened_by: 'ana@store.test', expected_float_minor: 1000, counted_float_minor: 1000, opening_variance_minor: 0 };

let n = 0;
let baseUrl: string;
let store: Awaited<ReturnType<typeof openOrderStore>>;
beforeEach(async () => {
  baseUrl = `https://closures-stats-${++n}.test`;
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
    requeue: vi.fn().mockResolvedValue(0), discard: vi.fn(), cancelOnStore: vi.fn(), payRestOnStore: vi.fn(), isStored: vi.fn().mockResolvedValue(false),
  });
  openRegister();
  vi.mocked(useFrameMenu).mockReturnValue(undefined);
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
/** Test 1's closure: float 10.00, expected 15.00, counted 13.00, 2.00 short. */
const shortClosure = (overrides: Partial<Closure> = {}) => closure({ till_expected: { cash: 1500 }, expected: { cash: 1500 },
  counted: { cash: 1300 }, variance: { cash: -200 }, breakdowns: { opening_float: { expected_minor: 1000, counted_minor: 1000 } },
  ...overrides });
async function mountClosures() {
  saveSession(localStorage, { baseUrl, email: 'admin@store.test', token: 'token' });
  render(<SessionProvider><ReportsScreen /><PortalHost /></SessionProvider>);
  fireEvent.click(await screen.findByTestId('register-strip-open-closures'));
  await screen.findByTestId('closures-view');
}
const follows = (first: HTMLElement, second: HTMLElement) =>
  !!(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
const { formatMoney } = closureContext('EUR', { name: 'Test shop' });
const value = (id: string) => screen.getByTestId(`closures-stat-${id}-value`);
const detail = (id: string) => screen.getByTestId(`closures-stat-${id}-detail`).textContent;

describe('Closures stat cards', () => {
  it('on a tablet, All sums the open session and today\'s closure between the filters and the tabs', async () => {
    await registerCollections(store.orders).closures.insert(shortClosure());
    await mountClosures();
    await screen.findByTestId('closure-row-c1');
    const stats = screen.getByTestId('closures-stats');
    expect(follows(screen.getByTestId('closures-filters'), stats)).toBe(true);
    expect(follows(stats, screen.getByTestId('closures-tabs'))).toBe(true);
    await waitFor(() => expect(value('sessions').textContent).toBe('2'));
    expect(detail('sessions')).toBe('1 open · 1 closed');
    expect(value('cash-open').textContent).toBe(formatMoney('20.00'));
    expect(detail('cash-open')).toBe('floats');
    expect(value('activity').textContent).toBe(`+${formatMoney('35.00')}`);
    expect(detail('activity')).toBe('sales − refunds ± movements');
    expect(value('cash-close').textContent).toBe(formatMoney('13.00'));
    expect(detail('cash-close')).toBe('1 count');
    expect(value('discrepancy').textContent).toBe(`−${formatMoney('2.00')}`);
    expect(value('discrepancy').getAttribute('data-class')).toContain('text-destructive');
    expect(detail('discrepancy')).toBe('1 short · 0 over · 0 exact');
  });

  it('follow the Closed and Open tabs', async () => {
    await registerCollections(store.orders).closures.insert(shortClosure());
    await mountClosures();
    await screen.findByTestId('closure-row-c1');
    fireEvent.click(screen.getByTestId('closures-tab-closed'));
    await waitFor(() => expect(value('sessions').textContent).toBe('1'));
    expect(detail('sessions')).toBe('0 open · 1 closed');
    fireEvent.click(screen.getByTestId('closures-tab-open'));
    await waitFor(() => expect(detail('sessions')).toBe('1 open · 0 closed'));
    expect(value('sessions').textContent).toBe('1');
    expect(value('cash-close').textContent).toBe(formatMoney('0.00'));
    expect(detail('cash-close')).toBe('0 counts');
    expect(detail('discrepancy')).toBe('0 short · 0 over · 0 exact');
  });

  it('choosing another cashier drops the open session from the cards', async () => {
    await registerCollections(store.orders).closures.insert(shortClosure({ closed_by: 'user-2', breakdowns: {
      closed_by_name: 'Ben', opening_float: { expected_minor: 1000, counted_minor: 1000 } } }));
    await mountClosures();
    await screen.findByTestId('closures-open-session');
    fireEvent.click(screen.getByTestId('closures-cashier'));
    fireEvent.click(screen.getByTestId('closures-cashier-option-user-2'));
    await waitFor(() => expect(screen.queryByTestId('closures-open-session')).toBeNull());
    expect(value('sessions').textContent).toBe('1');
    expect(detail('sessions')).toBe('0 open · 1 closed');
  });

  it('over a period with earlier days, the store\'s closures count too', async () => {
    const [today, yesterday] = [localDay(new Date()), dayBefore(localDay(new Date()))];
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ closures: [{ closureId: 'h7', number: 7,
      businessDay: yesterday, openedAt: new Date(Date.now() - 26 * 3600e3).toISOString(),
      closedAt: new Date(Date.now() - 24 * 3600e3).toISOString(), periodSalesTotalMinor: 900,
      counted: { cash: 900 }, tillExpected: { cash: 900 } }], more: false }))));
    await registerCollections(store.orders).closures.insert(shortClosure());
    await mountClosures();
    await screen.findByTestId('closure-row-c1');
    fireEvent.click(screen.getByTestId('closures-period'));
    const day = (d: string) => screen.queryByTestId(`closures-period-calendar-day-${d}`);
    if (!day(yesterday)) fireEvent.click(screen.getByTestId('closures-period-calendar-prev'));
    fireEvent.click(day(yesterday)!);
    if (!day(today)) fireEvent.click(screen.getByTestId('closures-period-calendar-next'));
    fireEvent.click(day(today)!);
    fireEvent.click(screen.getByTestId('closures-period-apply'));
    await screen.findByTestId('earlier-closure-h7');
    await waitFor(() => expect(value('sessions').textContent).toBe('3'));
    expect(detail('cash-open')).toBe('floats · 2 of 3 sessions');
    expect(detail('cash-close')).toBe('2 counts');
  });

  it('a phone keeps today\'s layout, without the cards', async () => {
    vi.mocked(useFrameMenu).mockReturnValue(() => {});
    await mountClosures();
    expect(screen.getByTestId('closures-tabs')).toBeTruthy();
    expect(screen.queryByTestId('closures-stats')).toBeNull();
  });
});
