// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { PortalHost } from '@tallyui/primitives';
import { createOrderBuilder, finalizeOrder, formatClosureDate, presetRange, useParkedSales, useStoreSettings, watchFresh, type PosOrder } from '@tallyui/pos';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ProductsScreen from '../app/index';
import { closureContext } from '../components/register-close';
import { useOutboxContext } from '../lib/outbox-context';
import { useRegister } from '../lib/register-context';
import { localDayStartIso } from '../lib/reports';
import { saveSession } from '../lib/session';
import { SessionProvider } from '../lib/session-context';
import { fetchStoreSettings, saveCachedSettings } from '../lib/store-settings';
import { useReplicatedProducts } from '../lib/use-replicated-products';
import { capabilities } from './pos-connector-mock';
import { OPEN_SESSION, openRegisterFixture } from './register-fixture';
import { setWindowWidth } from './window-width';

vi.mock('../lib/pos-connector', async (importOriginal) => (await import('./pos-connector-mock')).mockPosConnector(importOriginal));
vi.mock('expo-router', () => ({
  usePathname: () => '/',
  Redirect: ({ href }: { href: string }) => <span>redirect:{href}</span>,
  router: { replace: vi.fn(), push: vi.fn() },
  Stack: { Screen: ({ options }: { options: { headerRight?: () => ReactNode } }) => options.headerRight?.() },
}));
vi.mock('expo-localization', () => ({ getCalendars: () => [{ uses24hourClock: null }], getLocales: () => [{ languageTag: 'en-GB' }] }));
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

// A shift 1 h 43 min old, as v2's demo; only the clock and intervals are faked, so act and RTL keep their timeouts.
const SHIFT_NOW = Date.parse(OPEN_SESSION.opened_at_gmt) + (60 + 43) * 60_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(SHIFT_NOW);
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
    stockOverlay: undefined, lastStockCheckAt: null, reconcileStock: vi.fn(), unlisted: undefined, pullNotice: undefined, resumePull: vi.fn(), syncNow: vi.fn(), clearAndRefresh: vi.fn() });
  vi.mocked(useRegister).mockReturnValue(openRegisterFixture());
  vi.mocked(useParkedSales).mockReturnValue({ parked: [], discard: vi.fn() });
  vi.mocked(useOutboxContext).mockReturnValue({ orders: {} as never, state: { pending: 0, sending: false }, recent: [],
    savesInFlight: 0, stuckCommandIds: [], record: vi.fn(), flush: vi.fn(), requeue: vi.fn(), isStored: vi.fn() });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

async function mount(name?: string) {
  saveSession(localStorage, { baseUrl: 'https://store.test', email: 'admin@store.test', name,
    token: `header.${btoa(JSON.stringify({ exp: Date.now() / 1000 + 86400 }))}.signature` });
  await act(async () => { render(<SessionProvider><ProductsScreen /><PortalHost /></SessionProvider>); });
}
const open = () => fireEvent.click(screen.getByTestId('user-menu'));
// Computed as the sheet does, never a literal hour, so the suite passes in any machine time zone.
const openedAt = formatClosureDate(OPEN_SESSION.opened_at_gmt, closureContext('EUR', { name: 'Test shop' })).time;

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

it.each([['Alex Smith', 'AS', 1280], [undefined, 'A', 1280], ['Alex Smith', 'AS', 360], ['Alex Smith', 'AS', 1024]] as const)(
  'shows the account identity for %s (%s) at %i px', async (name, initials, width) => {
    setWindowWidth(width, 800);
    await mount(name);
    const displayName = name ?? 'admin@store.test';
    const button = screen.getByRole('button', { name: `Account: ${displayName}` });
    expect(button).toBe(screen.getByTestId('user-menu'));
    expect(button.textContent).toBe(initials);
    expect(within(button).getByTestId('user-menu-avatar').textContent).toBe(initials);
    expect(screen.queryByTestId('user-sheet')).toBeNull();
    open();
    expect(screen.getByTestId('user-sheet-name').textContent).toBe(displayName);
    expect(screen.getByTestId('user-sheet-context').textContent).toBe(`${name ? 'admin@store.test · ' : ''}Test shop · Register 1 · since ${openedAt} · 1 h 43 m`);
    expect(screen.getByTestId('user-sheet-avatar').textContent).toBe(initials);
    expect(screen.getByTestId('user-sheet-x').getAttribute('role')).toBe('button');
    const buttons = screen.getByTestId('user-sheet-sign-out').parentElement!;
    expect(buttons).toBe(screen.getByTestId('user-sheet-footer'));
    const phone = width < 600;
    expect(buttons.getAttribute('data-layout')).toBe(phone ? 'stacked' : 'row');
    expect(buttons.firstElementChild).toBe(screen.getByTestId(phone ? 'user-sheet-close' : 'user-sheet-sign-out'));
    expect(buttons.lastElementChild).toBe(screen.getByTestId(phone ? 'user-sheet-sign-out' : 'user-sheet-close'));
    expect(buttons.previousElementSibling).toBe(screen.getByTestId('user-sheet-admin'));
    expect(screen.getByTestId('user-sheet-admin').querySelector('svg')).not.toBeNull();
  });

it.each([1024, 360])('closes the sheet with the ✕ at %i px', async (width) => {
  setWindowWidth(width, 800);
  await mount(); open();
  fireEvent.click(screen.getByTestId('user-sheet-x'));
  expect(screen.queryByTestId('user-sheet')).toBeNull();
});

it.each([[599, 'stacked', 'user-sheet-close', 'user-sheet-sign-out'], [600, 'row', 'user-sheet-sign-out', 'user-sheet-close']] as const)(
  'lays the footer out at %i px as %s', async (width, layout, first, last) => {
    setWindowWidth(width, 800);
    await mount(); open();
    const footer = screen.getByTestId('user-sheet-footer');
    expect(footer.getAttribute('data-layout')).toBe(layout);
    expect(footer.firstElementChild).toBe(screen.getByTestId(first));
    expect(footer.lastElementChild).toBe(screen.getByTestId(last));
  });

it('signs out from the stacked phone footer without a session', async () => {
  setWindowWidth(360, 800);
  vi.mocked(useRegister).mockReturnValue({ ...useRegister(), register: { ...useRegister().register, session: null } });
  await mount(); open();
  expect(screen.getByTestId('user-sheet-footer').getAttribute('data-layout')).toBe('stacked');
  fireEvent.click(screen.getByTestId('user-sheet-sign-out'));
  expect(screen.queryByTestId('switch-confirm')).toBeNull();
  expect(localStorage.getItem('medusapos.session')).toBeNull();
  expect(screen.getByText('redirect:/login')).toBeTruthy();
});

it('disables sign-out in the stacked phone footer while a save locks it', async () => {
  setWindowWidth(360, 800);
  vi.mocked(useOutboxContext).mockReturnValue({ ...useOutboxContext(), savesInFlight: 1 });
  await mount(); open();
  expect(screen.getByTestId('user-sheet-footer').getAttribute('data-layout')).toBe('stacked');
  expect(screen.getByTestId('user-sheet-sign-out').getAttribute('aria-disabled')).toBe('true');
  fireEvent.click(screen.getByTestId('user-sheet-sign-out'));
  expect(screen.queryByTestId('switch-confirm')).toBeNull();
  expect(localStorage.getItem('medusapos.session')).not.toBeNull();
});

it('omits the drawer without an open session and skips an empty register name', async () => {
  vi.mocked(useRegister).mockReturnValue({ ...useRegister(), registerName: null, register: { ...useRegister().register, session: null } });
  await mount(); open();
  expect(screen.queryByTestId('user-sheet-drawer')).toBeNull();
  expect(screen.queryByTestId('user-sheet-handover')).toBeNull();
  expect(screen.getByTestId('user-sheet-context').textContent).toBe('Test shop');
  expect(screen.getByTestId('user-sheet-context').textContent).not.toContain('since');
  expect(screen.queryByTestId('user-sheet-drawer-opened')).toBeNull();
});

it('shows no opening time for a closed session', async () => {
  const register = useRegister().register;
  vi.mocked(useRegister).mockReturnValue({ ...useRegister(), register: { ...register, session: { ...register.session!, status: 'closed' } } });
  await mount(); open();
  expect(screen.getByTestId('user-sheet-context').textContent).toBe('Test shop · Register 1');
  expect(screen.queryByTestId('user-sheet-drawer-opened')).toBeNull();
});

it('shows when and by whom the drawer was opened, naming the signed-in opener', async () => {
  const register = useRegister().register;
  vi.mocked(useRegister).mockReturnValue({ ...useRegister(), register: { ...register, session: { ...register.session!, opened_by: 'admin@store.test' } } });
  await mount('Alex Smith'); open();
  expect(screen.getByTestId('user-sheet-drawer-opened').textContent).toBe(`Register 1 · opened ${openedAt} by Alex Smith`);
  expect(screen.getByTestId('user-sheet-context').textContent).toMatch(new RegExp(` · since ${openedAt} · 1 h 43 m$`));
});

it('names another cashier who opened the drawer by the stored id', async () => {
  const register = useRegister().register;
  vi.mocked(useRegister).mockReturnValue({ ...useRegister(), register: { ...register, session: { ...register.session!, opened_by: 'ana@store.test' } } });
  await mount('Alex Smith'); open();
  expect(screen.getByTestId('user-sheet-drawer-opened').textContent).toBe(`Register 1 · opened ${openedAt} by ana@store.test`);
});

it('ends the opened line with the signed-in opener’s initials avatar', async () => {
  const register = useRegister().register;
  vi.mocked(useRegister).mockReturnValue({ ...useRegister(), register: { ...register, session: { ...register.session!, opened_by: 'admin@store.test' } } });
  await mount('Alex Smith'); open();
  const avatar = screen.getByTestId('user-sheet-drawer-opener-avatar');
  expect(avatar.textContent).toBe('AS');
  expect(screen.getByTestId('user-sheet-drawer-opened').nextElementSibling).toBe(avatar);
});

it('shows another opener’s initials from the stored id', async () => {
  const register = useRegister().register;
  vi.mocked(useRegister).mockReturnValue({ ...useRegister(), register: { ...register, session: { ...register.session!, opened_by: 'ana@store.test' } } });
  await mount('Alex Smith'); open();
  expect(screen.getByTestId('user-sheet-drawer-opener-avatar').textContent).toBe('A');
});

it('shows no opener avatar when the session records no opener', async () => {
  await mount(); open();
  expect(screen.getByTestId('user-sheet-drawer-opened')).toBeTruthy();
  expect(screen.queryByTestId('user-sheet-drawer-opener-avatar')).toBeNull();
});

it('shows no opener avatar without a session', async () => {
  vi.mocked(useRegister).mockReturnValue({ ...useRegister(), register: { ...useRegister().register, session: null } });
  await mount(); open();
  expect(screen.queryByTestId('user-sheet-drawer-opener-avatar')).toBeNull();
});

it('shows the opening time in the header and the drawer while counting', async () => {
  const register = useRegister().register;
  vi.mocked(useRegister).mockReturnValue({ ...useRegister(), register: { ...register, session: { ...register.session!, status: 'counting' } } });
  await mount(); open();
  expect(screen.getByTestId('user-sheet-context').textContent).toBe(`Test shop · Register 1 · since ${openedAt} · 1 h 43 m`);
  expect(screen.getByTestId('user-sheet-drawer-opened').textContent).toBe(`Register 1 · opened ${openedAt}`);
});

it('starts the opened line with the time when the register has no name', async () => {
  vi.mocked(useRegister).mockReturnValue({ ...useRegister(), registerName: null });
  await mount(); open();
  expect(screen.getByTestId('user-sheet-drawer-opened').textContent).toBe(`opened ${openedAt}`);
  expect(screen.getByTestId('user-sheet-context').textContent).toBe(`Test shop · since ${openedAt} · 1 h 43 m`);
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
  expect(screen.getByTestId('user-sheet-drawer').textContent).toBe(`In the drawerRegister 1 · opened ${openedAt}Pay in · Pay out · Close register›Hand the till to the next cashier›`);
  fireEvent.click(screen.getByTestId('user-sheet-sign-out'));
  expect(screen.getByTestId('switch-confirm-title').textContent).toBe('Register 1 is still open. Close it first?');
});

it('counts the shift duration from the opening time while the sheet is open', async () => {
  vi.setSystemTime(Date.parse(OPEN_SESSION.opened_at_gmt));
  await mount(); open();
  const context = () => screen.getByTestId('user-sheet-context').textContent;
  expect(context()).toBe(`Test shop · Register 1 · since ${openedAt} · 0 m`);
  act(() => { vi.advanceTimersByTime(60_000); });
  expect(context()).toBe(`Test shop · Register 1 · since ${openedAt} · 1 m`);
  act(() => { vi.advanceTimersByTime(44 * 60_000); });
  expect(context()).toBe(`Test shop · Register 1 · since ${openedAt} · 45 m`);
});

it('shows no shift duration for a closed session', async () => {
  vi.mocked(useRegister).mockReturnValue({ ...useRegister(), registerName: null, register: { ...useRegister().register, session: null } });
  await mount(); open();
  const context = screen.getByTestId('user-sheet-context').textContent;
  expect(context).toBe('Test shop');
  expect(context).not.toMatch(/ m$/);
  expect(context).not.toContain('since');
});

it('stops the shift clock when the sheet closes and shows the current duration on reopening', async () => {
  await mount();
  const before = vi.getTimerCount();
  open();
  expect(vi.getTimerCount()).toBe(before + 1);
  fireEvent.click(screen.getByTestId('user-sheet-close'));
  expect(vi.getTimerCount()).toBe(before);
  vi.setSystemTime(SHIFT_NOW + 10 * 60_000);
  open();
  expect(screen.getByTestId('user-sheet-context').textContent).toBe(`Test shop · Register 1 · since ${openedAt} · 1 h 53 m`);
});

it('starts the drawer card with the cash badge, then the label and opened line, then the amount', async () => {
  vi.mocked(useRegister).mockReturnValue({ ...useRegister(), register: { ...useRegister().register, expected: { cash: 12345 } } });
  await mount(); open();
  const card = screen.getByTestId('user-sheet-drawer');
  const badge = screen.getByTestId('user-sheet-drawer-icon');
  expect(card.firstElementChild!.firstElementChild).toBe(badge);
  expect(badge.querySelector('svg')).not.toBeNull();
  const follows = (a: Node, b: Node) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  const label = within(card).getByText('In the drawer');
  expect(follows(badge, label)).toBe(true);
  expect(follows(screen.getByTestId('user-sheet-drawer-opened'), within(card).getByText('€123.45'))).toBe(true);
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
  expectConfirmOverSheet();
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
    if (action === 'cancel') expect(screen.getByTestId('user-sheet')).toBeTruthy();
    if (action === 'close-register') {
      expect(screen.queryByTestId('user-sheet')).toBeNull();
      expect(screen.getByTestId('register-panel')).toBeTruthy();
    }
  }
});

// As v2: the sheet stays open and the confirm portals after it, on top (jsdom has no z-order).
function expectConfirmOverSheet() {
  const sheet = screen.getByTestId('user-sheet');
  const confirm = screen.getByTestId('switch-confirm');
  expect(sheet.compareDocumentPosition(confirm) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
}

it('opens the sign-out confirm over the sheet at phone width, and Cancel returns to the sheet', async () => {
  setWindowWidth(599, 800);
  await mount(); open();
  fireEvent.click(screen.getByTestId('user-sheet-sign-out'));
  expectConfirmOverSheet();
  fireEvent.click(screen.getByTestId('switch-confirm-cancel'));
  expect(screen.queryByTestId('switch-confirm')).toBeNull();
  expect(screen.getByTestId('user-sheet')).toBeTruthy();
});

it('closes only the sign-out confirm on Escape, then the sheet on a second Escape', async () => {
  await mount(); open();
  fireEvent.click(screen.getByTestId('user-sheet-sign-out'));
  expectConfirmOverSheet();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByTestId('switch-confirm')).toBeNull();
  expect(screen.getByTestId('user-sheet')).toBeTruthy();
  expect(localStorage.getItem('medusapos.session')).not.toBeNull();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByTestId('user-sheet')).toBeNull();
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

it('puts the register label, name and Switch on one line', async () => {
  await mount(); open();
  const row = screen.getByTestId('user-sheet-register-row');
  const label = within(row).getByText('Register');
  const name = screen.getByTestId('user-sheet-register-name');
  const button = screen.getByTestId('user-sheet-register-switch');
  const line = label.parentElement!;
  expect(name.parentElement).toBe(line);
  expect(button.parentElement).toBe(line);
  const children = Array.from(line.children);
  expect(children.indexOf(label)).toBeLessThan(children.indexOf(name));
  expect(children.indexOf(name)).toBeLessThan(children.indexOf(button));
  const locked = screen.getByTestId('user-sheet-register-locked');
  expect(locked.parentElement).not.toBe(line);
  expect(row.contains(locked)).toBe(true);
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

const pendingSales = (pending: number) =>
  vi.mocked(useOutboxContext).mockReturnValue({ ...useOutboxContext(), state: { pending, sending: false } });

it('shows the amber awaiting-store card for one unsent sale', async () => {
  pendingSales(1);
  await mount(); open();
  const card = screen.getByTestId('user-sheet-awaiting');
  expect(screen.getByTestId('user-sheet-awaiting-title').textContent).toBe('Awaiting store · 1 sale');
  expect(card.textContent).toContain('Sent when you are signed in online');
});

it('counts several unsent sales in the plural', async () => {
  pendingSales(3);
  await mount(); open();
  expect(screen.getByTestId('user-sheet-awaiting-title').textContent).toBe('Awaiting store · 3 sales');
});

it('shows no awaiting-store card with nothing pending', async () => {
  await mount(); open();
  expect(screen.queryByTestId('user-sheet-awaiting')).toBeNull();
});

it('puts the awaiting-store card after the drawer card and before the register row', async () => {
  pendingSales(1);
  await mount(); open();
  const card = screen.getByTestId('user-sheet-awaiting');
  expect(screen.getByTestId('user-sheet-drawer').compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(card.compareDocumentPosition(screen.getByTestId('user-sheet-register-row')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it('drops the awaiting-store card once the outbox empties', async () => {
  pendingSales(2);
  await mount(); open();
  expect(screen.getByTestId('user-sheet-awaiting-title').textContent).toBe('Awaiting store · 2 sales');
  fireEvent.click(screen.getByTestId('user-sheet-close'));
  pendingSales(0);
  open();
  expect(screen.getByTestId('user-sheet')).toBeTruthy();
  expect(screen.queryByTestId('user-sheet-awaiting')).toBeNull();
});

it('shows the awaiting-store card without a drawer card', async () => {
  noSession();
  pendingSales(1);
  await mount(); open();
  expect(screen.getByTestId('user-sheet-awaiting')).toBeTruthy();
  expect(screen.queryByTestId('user-sheet-drawer')).toBeNull();
});
