// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOrderBuilder, finalizeOrder, type Closure, type PosOrder, type RegisterSession } from '@tallyui/pos';
import ReportsScreen from '../app/reports';
import { closureContext } from '../components/register-close';
import { X_PRINT_FAILED } from '../lib/closure-print';
import { openOrderStore, closeOrderStores, registerCollections } from '../lib/order-store';
import { useOutboxContext } from '../lib/outbox-context';
import { useRegister } from '../lib/register-context';
import { downloadCsv, localDay } from '../lib/reports';
import { saveSession } from '../lib/session';
import { SessionProvider } from '../lib/session-context';
import { saveCachedSettings } from '../lib/store-settings';

vi.mock('expo-localization', () => ({ getLocales: () => [{ languageTag: 'en-GB' }] }));
vi.mock('expo-router', () => ({
  Redirect: ({ href }: { href: string }) => <span>redirect:{href}</span>,
  router: { replace: vi.fn(), back: vi.fn(), push: vi.fn(), canGoBack: vi.fn(() => false) },
  Stack: { Screen: ({ options }: { options: { headerLeft?: () => ReactNode } }) =>
    <div data-testid="header-left">{options.headerLeft?.()}</div> },
}));
vi.mock('../lib/outbox-context', () => ({ useOutboxContext: vi.fn() }));
vi.mock('../lib/register-context', () => ({ useRegister: vi.fn() }));
vi.mock('../lib/reports', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/reports')>(), downloadCsv: vi.fn(),
}));

let n = 0;
let baseUrl: string;
let store: Awaited<ReturnType<typeof openOrderStore>>;
beforeEach(async () => {
  baseUrl = `https://reports-${++n}.test`;
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  });
  saveCachedSettings(localStorage, baseUrl, {
    storeName: 'Test shop', currency: 'EUR', location: { id: 'loc', name: 'Main', countryCode: 'IE' },
  });
  store = await openOrderStore(baseUrl);
  vi.mocked(useOutboxContext).mockReturnValue({
    orders: store.orders, state: { pending: 0, sending: false }, recent: [], savesInFlight: 0, stuckCommandIds: [],
    record: vi.fn().mockResolvedValue(undefined), flush: vi.fn().mockResolvedValue(undefined),
    requeue: vi.fn().mockResolvedValue(0), isStored: vi.fn().mockResolvedValue(false),
  });
  vi.mocked(useRegister).mockReturnValue({ boundRegisterId: 'register-1',
    registers: [{ id: 'register-1', name: 'Register 1' }],
    register: { session: null, expected: {}, salesCount: 0 }, registerName: 'Register 1' } as ReturnType<typeof useRegister>);
});
afterEach(async () => { cleanup(); await closeOrderStores(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

function mount(signedIn = true) {
  if (signedIn) saveSession(localStorage, { baseUrl, email: 'admin@store.test', token: 'token' });
  render(<SessionProvider><ReportsScreen /></SessionProvider>);
}
function openRegister(status: RegisterSession['status'] = 'open') {
  vi.mocked(useRegister).mockReturnValue({ boundRegisterId: 'register-1',
    registers: [{ id: 'register-1', name: 'Register 1' }], registerName: 'Register 1',
    register: { session: { id: 's1', register_id: 'register-1', store_key: baseUrl, status,
      opened_at_gmt: '2026-09-11T08:00:00Z', expected_float_minor: 1000, counted_float_minor: 1000, opening_variance_minor: 0 },
      expected: { cash: 2500 }, salesCount: 2 },
  } as unknown as ReturnType<typeof useRegister>);
}
function order(totalMinor: number, method: 'cash' | 'external', overrides: Partial<PosOrder> = {}): PosOrder {
  const builder = createOrderBuilder({ currency: overrides.currency ?? 'EUR', taxContext: { pricesIncludeTax: false, getTaxRatePpm: () => 0 } });
  builder.addLine({ productId: 'shirt', name: 'Shirt', unitPrice: { amount: totalMinor, currency: overrides.currency ?? 'EUR' } });
  builder.addPayment({ method, amountMinor: totalMinor });
  return { ...finalizeOrder(builder.getSnapshot()), createdAt: new Date().toISOString(), syncStatus: 'applied', ...overrides };
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

describe('ReportsScreen', () => {
  it('shows today\'s sales, per method, and what is left out', async () => {
    await store.orders.insert(order(1200, 'cash'));
    await store.orders.insert(order(800, 'external', { syncStatus: 'pending' }));
    await store.orders.insert(order(500, 'cash', { currency: 'USD' }));
    mount();
    const ctx = closureContext('EUR', { name: 'Test shop' });
    expect((await screen.findByTestId('reports-sales-count')).textContent).toBe('2');
    expect(screen.getByTestId('reports-sales-gross').textContent).toBe(ctx.formatMoney('20.00'));
    expect(screen.getByTestId('reports-method-cash').textContent).toBe(ctx.formatMoney('12.00'));
    const card = screen.getByTestId('reports-method-external');
    expect(card.textContent).toBe(ctx.formatMoney('8.00'));
    expect(within(card.parentElement!).getByText('Card')).toBeTruthy();
    expect(screen.getByTestId('reports-not-sent').textContent).toBe('1 sale not sent yet');
    expect(screen.getByTestId('reports-left-out').textContent).toBe('1 order in another currency left out');
  });
  it('shows empty states when there are no sales or closures today', async () => {
    mount();
    expect((await screen.findByTestId('reports-sales-empty')).textContent).toBe('No sales yet today');
    expect((await screen.findByTestId('closures-empty')).textContent).toBe('No closures yet today');
    expect(screen.queryByTestId('closures-export')).toBeNull();
  });
  it('lists today\'s closures of the bound register, newest first, with variance', async () => {
    const closures = registerCollections(store.orders).closures;
    await closures.insert(closure({ variance: { cash: -200 }, counted: { cash: 800 }, closed_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() }));
    await closures.insert(closure({ id: 'c2', number: 2 }));
    await closures.insert(closure({ id: 'c3', register_id: 'register-2' }));
    mount();
    await screen.findByTestId('closure-row-c2');
    expect(screen.getAllByTestId(/^closure-row-/).map((row) => row.getAttribute('data-testid'))).toEqual(['closure-row-c2', 'closure-row-c1']);
    expect(within(screen.getByTestId('closure-row-c1')).getByText('Closure #1')).toBeTruthy();
    expect(screen.getByTestId('closure-variance-c1').textContent).toBe(`Short ${closureContext('EUR', { name: 'Test shop' }).formatMoney('2.00')}`);
    expect(screen.getByTestId('closure-variance-c2').textContent).toBe('Exact');
    expect(screen.queryByTestId('closure-row-c3')).toBeNull();
  });
  it('Export CSV downloads today\'s rows and reports a failure', async () => {
    await registerCollections(store.orders).closures.insert(closure());
    const today = localDay(new Date());
    mount();
    fireEvent.click(await screen.findByTestId('closures-export'));
    expect(downloadCsv).toHaveBeenCalledTimes(1);
    const [filename, csv] = vi.mocked(downloadCsv).mock.calls[0];
    expect(filename).toBe(`closures-${today}-${today}.csv`);
    expect(csv.split('\r\n')[0]).toMatch(/^"Business day","Closure","Register"/);
    expect(csv.split('\r\n')[1]).toContain('"Register 1"');
    vi.mocked(downloadCsv).mockImplementationOnce(() => { throw new Error('Download failed'); });
    fireEvent.click(screen.getByTestId('closures-export'));
    expect((await screen.findByTestId('closures-export-error')).textContent).toBe('Export failed. Try again.');
  });
  it('redirects to login without a session', () => {
    mount(false);
    expect(screen.getByText('redirect:/login')).toBeTruthy();
  });

  it('shows Print X report only while the register session is open', () => {
    document.getElementById('closure-print-frame')?.remove();
    mount();
    expect(screen.queryByTestId('reports-x-print')).toBeNull();
    cleanup();
    openRegister();
    mount();
    expect(screen.getByTestId('reports-x-print').textContent).toBe('Print X report');
    cleanup();
    openRegister('counting');
    mount();
    expect(screen.queryByTestId('reports-x-print')).toBeNull();
  });

  it('Print X report prints the open session in a frame', async () => {
    document.getElementById('closure-print-frame')?.remove();
    openRegister();
    mount();
    fireEvent.click(screen.getByTestId('reports-x-print'));
    const frame = document.getElementById('closure-print-frame') as HTMLIFrameElement;
    const print = vi.spyOn(frame.contentWindow!, 'print').mockImplementation(() => {});
    await waitFor(() => expect(print).toHaveBeenCalledOnce());
    const page = frame.contentDocument!;
    const row = (scope: ParentNode, label: string) => Array.from(scope.querySelectorAll('tr'))
      .find((tr) => tr.querySelector('th')?.textContent === label)?.querySelector('td')?.textContent;
    expect(page.querySelector('h2')?.textContent).toBe('X report');
    expect(row(page, 'Register')).toBe('Register 1');
    expect(row(page, 'Sales')).toBe('2 sales');
    const cash = Array.from(page.querySelectorAll('section.tender')).find((tender) => tender.querySelector('h3')?.textContent === 'Cash');
    expect(row(cash!, 'Expected')).toBe('€25.00');
    expect(screen.getByTestId('reports-x-print').textContent).toBe('Print X report');
  });

  it('a failed X report print says why', async () => {
    document.getElementById('closure-print-frame')?.remove();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    openRegister();
    mount();
    fireEvent.click(screen.getByTestId('reports-x-print'));
    const frame = document.getElementById('closure-print-frame') as HTMLIFrameElement;
    vi.spyOn(frame.contentWindow!, 'print').mockImplementation(() => { throw new Error('boom'); });
    expect((await screen.findByTestId('reports-x-print-error')).textContent).toBe(X_PRINT_FAILED);
    warn.mockRestore();
  });
});
