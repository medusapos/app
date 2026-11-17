// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { PortalHost } from '@tallyui/primitives';
import { createOrderBuilder, finalizeOrder, presetRange, useParkedSales, useStoreSettings, watchFresh, type PosOrder } from '@tallyui/pos';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ProductsScreen from '../app/index';
import { useOutboxContext } from '../lib/outbox-context';
import { useRegister } from '../lib/register-context';
import { localDayStartIso } from '../lib/reports';
import { saveSession } from '../lib/session';
import { SessionProvider } from '../lib/session-context';
import { fetchStoreSettings, saveCachedSettings } from '../lib/store-settings';
import { useReplicatedProducts } from '../lib/use-replicated-products';
import { capabilities } from './pos-connector-mock';
import { openRegisterFixture } from './register-fixture';
import { setWindowWidth } from './window-width';

vi.mock('../lib/pos-connector', async (importOriginal) => (await import('./pos-connector-mock')).mockPosConnector(importOriginal));
vi.mock('expo-router', () => ({
  Redirect: ({ href }: { href: string }) => <span>redirect:{href}</span>,
  router: { replace: vi.fn(), push: vi.fn() },
  Stack: { Screen: ({ options }: { options: { headerRight?: () => ReactNode } }) => options.headerRight?.() },
}));
vi.mock('expo-localization', () => ({ getCalendars: () => [{ uses24hourClock: null }] }));
vi.mock('../lib/product-cache', () => ({ clearProductCache: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../lib/use-replicated-products', () => ({ useReplicatedProducts: vi.fn() }));
vi.mock('../lib/outbox-context', () => ({ useOutboxContext: vi.fn() }));
vi.mock('../lib/register-context', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/register-context')>(), useRegister: vi.fn(),
}));
const sales = vi.hoisted(() => ({ orders: [] as PosOrder[], unsubscribe: vi.fn() }));
vi.mock('@tallyui/pos', async (importOriginal) => ({
  ...await importOriginal<typeof import('@tallyui/pos')>(), useStoreSettings: vi.fn(), useParkedSales: vi.fn(),
  watchFresh: vi.fn(() => ({ subscribe: (next: (orders: PosOrder[]) => void) => {
    next(sales.orders);
    return { unsubscribe: sales.unsubscribe };
  } })),
}));
vi.mock('../lib/store-settings', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/store-settings')>(), fetchStoreSettings: vi.fn(),
}));

beforeEach(() => {
  sales.orders = [];
  setWindowWidth(1280, 800);
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  });
  const settings = { storeName: 'Test shop', currency: 'EUR', location: { id: 'loc', name: 'Main', countryCode: 'dk' } };
  saveCachedSettings(localStorage, 'https://store.test', settings);
  capabilities.mockResolvedValue(undefined);
  vi.mocked(fetchStoreSettings).mockResolvedValue(settings);
  vi.mocked(useStoreSettings).mockReturnValue({ state: 'ready', settings: {
    currency: 'EUR', pricesIncludeTax: false, taxRatesPpm: { default: 250000 },
    pricingContext: { region_id: 'reg_eu', currency_code: 'eur', publishable_key: 'pk_1' },
  }, refresh: () => {} });
  vi.mocked(useReplicatedProducts).mockReturnValue({ products: [], state: 'synced', error: null, lastSyncedAt: null,
    stockOverlay: undefined, lastStockCheckAt: null, reconcileStock: vi.fn(), unlisted: undefined, pullNotice: undefined, resumePull: vi.fn() });
  vi.mocked(useRegister).mockReturnValue(openRegisterFixture());
  vi.mocked(useParkedSales).mockReturnValue({ parked: [], discard: vi.fn() });
  vi.mocked(useOutboxContext).mockReturnValue({ orders: {} as never, state: { pending: 0, sending: false }, recent: [],
    savesInFlight: 0, stuckCommandIds: [], record: vi.fn(), flush: vi.fn(), requeue: vi.fn(), isStored: vi.fn() });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

async function mount(name?: string) {
  saveSession(localStorage, { baseUrl: 'https://store.test', email: 'admin@store.test', name,
    token: `header.${btoa(JSON.stringify({ exp: Date.now() / 1000 + 86400 }))}.signature` });
  await act(async () => { render(<SessionProvider><ProductsScreen /><PortalHost /></SessionProvider>); });
}
const open = () => fireEvent.click(screen.getByTestId('user-menu'));

function todayOrders(rows: readonly (readonly [number, string, string, string | undefined])[]): PosOrder[] {
  return rows.map(([amount, registerId, currency, cashierRef]) => {
    const builder = createOrderBuilder({ currency, taxContext: { pricesIncludeTax: false, getTaxRatePpm: () => 0 } });
    builder.addLine({ productId: 'shirt', name: 'Shirt', unitPrice: { amount, currency } });
    builder.addPayment({ method: 'cash', amountMinor: amount });
    return { ...finalizeOrder(builder.getSnapshot()), createdAt: new Date().toISOString(), registerId, cashierRef };
  });
}

it('shows the signed-in cashier’s sales today on this till in the store currency', async () => {
  const me = 'admin@store.test';
  const till = 'device-till-1';
  sales.orders = todayOrders([[1200, till, 'EUR', me], [350, till, 'EUR', me], [900, till, 'EUR', me],
    [800, till, 'USD', me], [700, till, 'EUR', 'other@store.test'], [600, till, 'EUR', undefined]]);
  await mount(); open();
  expect(screen.getByTestId('user-sheet-sales-today').textContent).toBe('Your sales today3 sales€24.50');
  expect(screen.getByTestId('user-sheet-sales-count').textContent).toBe('3 sales');
  expect(watchFresh).toHaveBeenCalledExactlyOnceWith(useOutboxContext().orders,
    { selector: { createdAt: { $gte: localDayStartIso(presetRange('today', new Date(), 'device').from) } } });
});

it('shows zero sales today with no orders', async () => {
  await mount(); open();
  expect(screen.getByTestId('user-sheet-sales-today').textContent).toBe('Your sales today0 sales€0.00');
});

it('counts a single sale in the singular', async () => {
  sales.orders = todayOrders([[500, 'register-1', 'EUR', 'admin@store.test']]);
  await mount(); open();
  expect(screen.getByTestId('user-sheet-sales-today').textContent).toBe('Your sales today1 sale€5.00');
});

it('omits sales today and does not subscribe while orders is null', async () => {
  vi.mocked(useOutboxContext).mockReturnValue({ ...useOutboxContext(), orders: null });
  await mount(); open();
  expect(screen.queryByTestId('user-sheet-sales-today')).toBeNull();
  expect(watchFresh).not.toHaveBeenCalled();
});

it('subscribes only while open and unsubscribes when closed', async () => {
  await mount();
  expect(watchFresh).not.toHaveBeenCalled();
  open();
  expect(watchFresh).toHaveBeenCalledTimes(1);
  expect(sales.unsubscribe).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId('user-sheet-close'));
  expect(sales.unsubscribe).toHaveBeenCalledTimes(1);
});

it.each([['Alex Smith', 'AS', 1280], [undefined, 'A', 1280], ['Alex Smith', 'AS', 360]] as const)(
  'shows the account identity for %s (%s) at %i px', async (name, initials, width) => {
    setWindowWidth(width, 800);
    await mount(name);
    const displayName = name ?? 'admin@store.test';
    const button = screen.getByRole('button', { name: `Account: ${displayName}` });
    expect(button).toBe(screen.getByTestId('user-menu'));
    expect(button.textContent).toBe(initials + (width === 360 ? '' : displayName));
    expect(screen.queryByTestId('user-sheet')).toBeNull();
    open();
    expect(screen.getByTestId('user-sheet-name').textContent).toBe(displayName);
    expect(screen.getByTestId('user-sheet-context').textContent).toBe(`${name ? 'admin@store.test · ' : ''}Test shop · Register 1`);
    const buttons = screen.getByTestId('user-sheet-sign-out').parentElement!;
    expect(buttons.firstElementChild).toBe(screen.getByTestId('user-sheet-sign-out'));
    expect(buttons.lastElementChild).toBe(screen.getByTestId('user-sheet-close'));
    expect(buttons.previousElementSibling).toBe(screen.getByTestId('user-sheet-admin'));
    expect(screen.getByTestId('user-sheet-admin').querySelector('svg')).not.toBeNull();
  });

it('omits the drawer without an open session and skips an empty register name', async () => {
  vi.mocked(useRegister).mockReturnValue({ ...useRegister(), registerName: null, register: { ...useRegister().register, session: null } });
  await mount(); open();
  expect(screen.queryByTestId('user-sheet-drawer')).toBeNull();
  expect(screen.queryByTestId('user-sheet-handover')).toBeNull();
  expect(screen.getByTestId('user-sheet-context').textContent).toBe('Test shop');
});

it.each(['open', 'counting'] as const)('shows expected cash while %s and opens the register panel', async (status) => {
  const register = useRegister().register;
  vi.mocked(useRegister).mockReturnValue({ ...useRegister(), register: { ...register, session: { ...register.session!, status }, expected: { cash: 12345 } } });
  await mount(); open();
  const drawer = within(screen.getByTestId('user-sheet-drawer'));
  expect(drawer.getByText('In the drawer')).toBeTruthy();
  expect(drawer.getByText('€123.45')).toBeTruthy();
  fireEvent.click(drawer.getByTestId('user-sheet-register'));
  expect(screen.queryByTestId('user-sheet')).toBeNull();
  expect(screen.getByTestId('register-panel')).toBeTruthy();
});

it('shows zero expected cash for an open session with empty expected totals', async () => {
  vi.mocked(useRegister).mockReturnValue({ ...useRegister(), register: { ...useRegister().register, expected: {} } });
  await mount(); open();
  expect(within(screen.getByTestId('user-sheet-drawer')).getByText('€0.00')).toBeTruthy();
});

it('hides the drawer amount while blind', async () => {
  vi.mocked(useRegister).mockReturnValue({ ...useRegister(), register: { ...useRegister().register, blind: true } });
  await mount(); open();
  expect(screen.getByTestId('user-sheet-drawer').textContent).toBe('In the drawerPay in · Pay out · Close register›Hand the till to the next cashier›');
  fireEvent.click(screen.getByTestId('user-sheet-sign-out'));
  expect(screen.getByTestId('switch-confirm-title').textContent).toBe('Register 1 is still open. Close it first?');
});

it('opens Medusa Admin and closes the sheet', async () => {
  const openWindow = vi.spyOn(window, 'open').mockReturnValue(null);
  await mount(); open();
  fireEvent.click(screen.getByTestId('user-sheet-admin'));
  expect(openWindow).toHaveBeenCalledExactlyOnceWith('https://store.test/app', '_blank', 'noopener,noreferrer');
  openWindow.mockRestore();
  fireEvent.click(screen.getByTestId('user-sheet-close'));
  expect(screen.queryByTestId('user-sheet')).toBeNull();
});

it.each(['confirm', 'cancel', 'close-register'])('confirms sign-out with an open session: %s', async (action) => {
  await mount(); open();
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
  expect(screen.queryByTestId('user-sheet')).toBeNull();
  expect(screen.getByTestId('switch-confirm')).toBeTruthy();
  expect(screen.getByTestId('switch-confirm-title').textContent).toBe('Register 1 is still open at €100.00. Close it first?');
  expect(localStorage.getItem('medusapos.session')).not.toBeNull();
  fireEvent.click(screen.getByTestId(`switch-confirm-${action}`));
  expect(screen.queryByTestId('switch-confirm')).toBeNull();
  if (action === 'confirm') {
    expect(localStorage.getItem('medusapos.session')).toBeNull();
    expect(screen.queryByTestId('user-menu')).toBeNull();
    expect(screen.getByText('redirect:/login')).toBeTruthy();
  } else {
    expect(localStorage.getItem('medusapos.session')).not.toBeNull();
    if (action === 'close-register') expect(screen.getByTestId('register-panel')).toBeTruthy();
  }
});

it.each([0, 1])('signs out without a session with %i parked sales', async (count) => {
  vi.mocked(useRegister).mockReturnValue({ ...useRegister(), register: { ...useRegister().register, session: null } });
  if (count) vi.mocked(useParkedSales).mockReturnValue({ parked: [
    { id: 'parked-1', itemCount: 1, totalMinor: 100, parkedAt: '2026-09-28T08:00:00.000Z', source: 'local' },
  ], discard: vi.fn() });
  await mount(); open();
  fireEvent.click(screen.getByTestId('user-sheet-sign-out'));
  if (count) {
    expect(screen.getByTestId('switch-confirm')).toBeTruthy();
    expect(screen.getByTestId('switch-warning-parkedSales').textContent).toBe('1 parked sale');
    expect(localStorage.getItem('medusapos.session')).not.toBeNull();
    fireEvent.click(screen.getByTestId('switch-confirm-confirm'));
  }
  expect(screen.queryByTestId('switch-confirm')).toBeNull();
  expect(localStorage.getItem('medusapos.session')).toBeNull();
  expect(screen.getByText('redirect:/login')).toBeTruthy();
});

it.each(['confirm', 'cancel'])('hands the open till to the next cashier: %s', async (action) => {
  await mount(); open();
  fireEvent.click(screen.getByTestId('user-sheet-handover'));
  expect(screen.queryByTestId('user-sheet')).toBeNull();
  expect(screen.getByTestId('switch-confirm')).toBeTruthy();
  expect(screen.getByTestId('switch-confirm-title').textContent).toBe('Hand the till to the next cashier?');
  expect(screen.getByTestId('switch-confirm-description').textContent).toBe('The drawer stays open on Register 1.');
  expect(screen.queryByTestId('switch-confirm-handover')).toBeNull();
  fireEvent.click(screen.getByTestId(`switch-confirm-${action}`));
  expect(screen.queryByTestId('switch-confirm')).toBeNull();
  expect(localStorage.getItem('medusapos.session') === null).toBe(action === 'confirm');
});

it('disables hand-over and sign-out while a save locks sign-out', async () => {
  vi.mocked(useOutboxContext).mockReturnValue({ ...useOutboxContext(), savesInFlight: 1 });
  await mount(); open();
  for (const id of ['user-sheet-handover', 'user-sheet-sign-out']) {
    expect(screen.getByTestId(id).getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(screen.getByTestId(id));
  }
  expect(screen.queryByTestId('switch-confirm')).toBeNull();
  expect(localStorage.getItem('medusapos.session')).not.toBeNull();
});

const noSession = () => vi.mocked(useRegister).mockReturnValue({ ...useRegister(), register: { ...useRegister().register, session: null } });

it('shows the bound register with Switch disabled while its session is open', async () => {
  await mount(); open();
  const row = within(screen.getByTestId('user-sheet-register-row'));
  expect(row.getByText('Register')).toBeTruthy();
  expect(row.getByTestId('user-sheet-register-name').textContent).toBe('Register 1');
  expect(row.getByTestId('user-sheet-register-locked').textContent).toBe('Close the register first');
  expect(within(screen.getByTestId('user-sheet-drawer')).queryByTestId('user-sheet-register-row')).toBeNull();
  const button = screen.getByTestId('user-sheet-register-switch');
  expect(button.getAttribute('aria-disabled')).toBe('true');
  expect(button.getAttribute('aria-label')).toBe('Switch register');
  fireEvent.click(button);
  expect(useRegister().unbind).not.toHaveBeenCalled();
  expect(screen.getByTestId('user-sheet')).toBeTruthy();
});

it.each(['counting', 'closed'] as const)('disables Switch while the session is %s', async (status) => {
  const register = useRegister().register;
  vi.mocked(useRegister).mockReturnValue({ ...useRegister(), register: { ...register, session: { ...register.session!, status } } });
  await mount(); open();
  expect(screen.getByTestId('user-sheet-register-switch').getAttribute('aria-disabled')).toBe('true');
  expect(screen.getByTestId('user-sheet-register-locked')).toBeTruthy();
  fireEvent.click(screen.getByTestId('user-sheet-register-switch'));
  expect(useRegister().unbind).not.toHaveBeenCalled();
});

it('switches the register without a session: closes the sheet and unbinds the till', async () => {
  noSession();
  await mount(); open();
  expect(screen.queryByTestId('user-sheet-register-locked')).toBeNull();
  expect(screen.getByTestId('user-sheet-register-switch').getAttribute('aria-disabled')).not.toBe('true');
  await act(async () => { fireEvent.click(screen.getByTestId('user-sheet-register-switch')); });
  expect(screen.queryByTestId('user-sheet')).toBeNull();
  expect(useRegister().unbind).toHaveBeenCalledTimes(1);
});

it('warns and stays put when unbinding fails', async () => {
  noSession();
  const error = new Error('storage unavailable');
  vi.mocked(useRegister().unbind).mockRejectedValueOnce(error);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await mount(); open();
  await act(async () => { fireEvent.click(screen.getByTestId('user-sheet-register-switch')); });
  expect(warn).toHaveBeenCalledWith('Could not unbind the register:', error);
  warn.mockRestore();
});

it('omits the register row while the till is unbound', async () => {
  vi.mocked(useRegister).mockReturnValue({ ...useRegister(), boundRegisterId: null, register: { ...useRegister().register, session: null } });
  await mount(); open();
  expect(screen.getByTestId('user-sheet')).toBeTruthy();
  expect(screen.queryByTestId('user-sheet-register-row')).toBeNull();
});
