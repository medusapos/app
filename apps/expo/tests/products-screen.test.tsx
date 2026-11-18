// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { BehaviorSubject } from 'rxjs';
import { formatStockSyncTime, SyncStatus } from '@tallyui/components';
import { PortalHost } from '@tallyui/primitives';
import { SignInError, type StoreSettings as PricingSettings } from '@tallyui/core';
import type { StorageHealth as StorageHealthReading } from '@tallyui/database';
import { createOrderBuilder, DEFAULT_CATALOGUE_VIEW_STATE, finalizeOrder, useOrderOutbox, useStoreSettings, type PosOrder } from '@tallyui/pos';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { router } from 'expo-router';
import { EARLIER_SALE_SAVING } from '../components/earlier-sale-note';
import { storeConfig } from '../lib/config';
import { formatReceiptDate } from '../lib/format-date';
import { DEFAULT_CART_SETTINGS, loadCartSettings, saveCartSettings } from '../lib/cart-settings';
import { useCatalogueSnapshot } from '../lib/catalogue-snapshot';
import { clearProductCache } from '../lib/product-cache';
import { DEFAULT_SCANNER_SETTINGS, saveScannerSettings } from '../lib/scanner-settings';
import { forgetDeletedDefaultCustomer, loadDefaultCustomer, saveDefaultCustomer } from '../lib/default-customer';
import { loadCashierCustomer, saveDefaultCustomerIsCashier } from '../lib/cashier-customer';
import { login, LoginError, refreshSession, saveSession } from '../lib/session';
import { capabilities } from './pos-connector-mock';
import { SessionProvider, useSession } from '../lib/session-context';
import { watchStorageHealth } from '../lib/storage-health';
import { useReplicatedProducts } from '../lib/use-replicated-products';
import { fetchStoreSettings, saveCachedSettings, StoreSettingsError, type StoreSettings } from '../lib/store-settings';
import ProductsScreen from '../app/index';
import { AppFrame } from '../components/app-frame';
import OrdersScreen from '../app/orders';
import { OutboxProvider, useOutboxContext } from '../lib/outbox-context';
import { OutboxStrip, StoreRefused } from '../components/store-refused';
import { useRegister } from '../lib/register-context';
import { openRegisterFixture } from './register-fixture';
import { setWindowWidth } from './window-width';
import { cartLine, cartLineCells, pickMethod, take } from './tender-pane';

// v2's cart foot (TallyUI 3.18.0): Checkout opens the tender on Cash through the register gate; the Card terminal
// tile then takes the whole balance, as the cart's old Card terminal button did.
const checkout = () => act(async () => { fireEvent.click(screen.getByTestId('cart-checkout')); });
async function payByCard() { await checkout(); pickMethod('external'); take(); }

vi.mock('../lib/pos-connector', async (importOriginal) => (await import('./pos-connector-mock')).mockPosConnector(importOriginal));
vi.mock('expo-router', () => ({
  Redirect: ({ href }: { href: string }) => <span>redirect:{href}</span>,
  router: { replace: vi.fn(), push: vi.fn(), dismissTo: vi.fn() }, usePathname: () => '/',
  Stack: { Screen: ({ options }: { options: { title?: string; headerRight?: () => ReactNode } }) => <>
    <span data-testid="screen-title" data-title={options.title} />{options.headerRight?.()}
  </> },
}));
// expo-localization's native module isn't available under vitest.
vi.mock('expo-localization', () => ({ getCalendars: () => [{ uses24hourClock: null }], getLocales: () => [{ languageTag: 'en-GB' }] }));
vi.mock('../lib/use-replicated-products', () => ({ useReplicatedProducts: vi.fn() }));
// A fixed outbox value, except in the hung-save tests: those run the real OutboxProvider and useOutboxContext
// (kept in `realOutbox`) over a stand-in for TallyUI's useOrderOutbox.
const realOutbox = vi.hoisted(() => ({} as { useOutboxContext: typeof import('../lib/outbox-context').useOutboxContext }));
vi.mock('../lib/outbox-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/outbox-context')>();
  realOutbox.useOutboxContext = actual.useOutboxContext;
  return { ...actual, useOutboxContext: vi.fn() };
});
// The register (ADR 0017): bound and open (register-fixture.ts), so sales can be paid; register-screen.test.tsx
// covers the gate itself. OutboxProvider's own RegisterProvider passes through: the hung-save tests' orders are a stand-in.
vi.mock('../lib/register-context', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/register-context')>(),
  RegisterProvider: ({ children }: { children: ReactNode }) => children, useRegister: vi.fn(),
}));
vi.mock('expo-linking', () => ({ openURL: vi.fn().mockResolvedValue(true) }));
vi.mock('../lib/product-cache', () => ({ clearProductCache: vi.fn().mockResolvedValue(undefined) }));
// The session's network calls, driven per test (the sign-out paths below); everything else in it is real.
vi.mock('../lib/session', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/session')>(), login: vi.fn(), refreshSession: vi.fn(),
}));
// store-settings-flow.test.tsx covers the settings states; here the store settings are ready.
vi.mock('@tallyui/pos', async (importOriginal) => ({
  ...await importOriginal<typeof import('@tallyui/pos')>(), useStoreSettings: vi.fn(), useOrderOutbox: vi.fn(),
  watchFresh: vi.fn(() => ({ subscribe: () => ({ unsubscribe: vi.fn() }) })),
}));
vi.mock('../lib/store-settings', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/store-settings')>(), fetchStoreSettings: vi.fn(),
}));

type Replicated = ReturnType<typeof useReplicatedProducts>;
const reconcileStock = vi.fn(async () => {});
const replicated = (over: Partial<Replicated>): Replicated => ({ products: [], state: 'synced', error: null,
  lastSyncedAt: null, stockOverlay: undefined, lastStockCheckAt: null, reconcileStock, unlisted: undefined,
  pullNotice: undefined, resumePull: vi.fn(), ...over });

const settings: StoreSettings = {
  storeName: 'Test shop', currency: 'EUR', location: { id: 'loc', name: 'Main', countryCode: 'dk' },
};
const pricing: PricingSettings = {
  currency: 'EUR', pricesIncludeTax: false, taxRatesPpm: { default: 250000 },
  pricingContext: { region_id: 'reg_eu', currency_code: 'eur', publishable_key: 'pk_1' },
};
const originalDemoMode = storeConfig.demo;
beforeEach(() => {
  setWindowWidth(1280, 800);
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  });
  saveCachedSettings(localStorage, 'https://store.test', settings);
  capabilities.mockResolvedValue(undefined);
  vi.mocked(fetchStoreSettings).mockResolvedValue(settings);
  vi.mocked(useStoreSettings).mockReturnValue({ state: 'ready', settings: pricing, refresh: () => {} });
  vi.mocked(useReplicatedProducts).mockReturnValue(replicated({}));
  vi.mocked(useRegister).mockReturnValue(openRegisterFixture());
  // Not null by default: the order store is open unless a test says otherwise (#86 review, item 5).
  vi.mocked(useOutboxContext).mockReturnValue({ orders: {} as never, state: { pending: 0, sending: false }, recent: [], savesInFlight: 0, stuckCommandIds: [], record: vi.fn().mockResolvedValue(undefined), flush: vi.fn().mockResolvedValue(undefined), requeue: vi.fn().mockResolvedValue(0), isStored: vi.fn().mockResolvedValue(false) });
});

describe('ProductsScreen catalogue', () => {
  it('starts the cart on the saved default customer', async () => {
    saveDefaultCustomer(localStorage, 'https://store.test', { id: 'ada', name: 'Ada Lovelace' });
    try {
      await mount();
      expect(screen.getByRole('button', { name: 'Customer: Ada Lovelace' })).toBeTruthy();
    } finally {
      saveDefaultCustomer(localStorage, 'https://store.test', null);
    }
  });

  // Medusa's /admin/customers?q= search, stubbed at fetch; anything else fails as offline.
  function stubCustomerSearch(customers: { id: string; first_name: string; last_name: string; email: string }[]) {
    const fetchStub = vi.fn(async (url: string) => url.startsWith('https://store.test/admin/customers?q=')
      ? { ok: true, status: 200, json: async () => ({ customers: customers.map((c) => ({ ...c, deleted_at: null })) }) }
      : Promise.reject(new TypeError('Failed to fetch')));
    vi.stubGlobal('fetch', fetchStub);
    return fetchStub;
  }
  const cashier = { id: 'cus_admin', first_name: 'Store', last_name: 'Admin', email: 'admin@store.test' };

  it('with Default customer is cashier on, the cart starts on the cashier\'s Medusa customer, not the saved default', async () => {
    saveDefaultCustomer(localStorage, 'https://store.test', { id: 'ada', name: 'Ada Lovelace' });
    saveDefaultCustomerIsCashier(localStorage, 'https://store.test', true);
    localStorage.setItem('medusapos.cashier-customer.https://store.test.admin@store.test',
      JSON.stringify({ id: 'cus_admin', name: 'Store Admin', email: 'admin@store.test' }));
    const fetchStub = stubCustomerSearch([cashier]);
    await mount();
    expect(screen.getByRole('button', { name: 'Customer: Store Admin' })).toBeTruthy();
    await vi.waitFor(() => expect(fetchStub).toHaveBeenCalledWith(
      'https://store.test/admin/customers?q=admin%40store.test&limit=20', expect.anything()));
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'Customer: Store Admin' })).toBeTruthy();
    expect(loadCashierCustomer(localStorage, 'https://store.test', 'admin@store.test')).toEqual({ id: 'cus_admin', name: 'Store Admin', email: 'admin@store.test' });
  });

  it('with Default customer is cashier on and no customer with that email, the cart starts on the saved default', async () => {
    saveDefaultCustomer(localStorage, 'https://store.test', { id: 'ada', name: 'Ada Lovelace' });
    saveDefaultCustomerIsCashier(localStorage, 'https://store.test', true);
    const fetchStub = stubCustomerSearch([{ ...cashier, id: 'cus_x', email: 'xadmin@store.test' }]);
    await mount();
    await vi.waitFor(() => expect(fetchStub).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'Customer: Ada Lovelace' })).toBeTruthy();
    expect(loadCashierCustomer(localStorage, 'https://store.test', 'admin@store.test')).toBeNull();
  });

  it('a deleted default customer: the cart starts as Guest and the sale is sent without a customer', async () => {
    saveDefaultCustomer(localStorage, 'https://store.test', { id: 'ada', name: 'Ada Lovelace', email: 'ada@example.com' });
    vi.mocked(useOutboxContext).mockReturnValue({ ...useOutboxContext(), recent: [
      { ...savedSale(), syncStatus: 'applied', warnings: [{ code: 'customer_ignored', customerId: 'ada' }] },
    ] });
    vi.mocked(useReplicatedProducts).mockReturnValue(replicated({ products: [{
      id: 'shirt', title: 'Shirt', status: 'published', variants: [{ id: 'blue', title: 'Blue', sku: 'BLUE',
        prices: [{ amount: 12, currency_code: 'eur' }] }],
    }] }));
    await mount();
    expect(screen.getByRole('button', { name: 'Customer: Guest' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Customer: Ada Lovelace' })).toBeNull();
    expect(loadDefaultCustomer(localStorage, 'https://store.test')).toBeNull();
    fireEvent.click(screen.getByTestId('product-tile-Shirt'));
    await payByCard();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Complete sale' })); });
    const record = vi.mocked(useOutboxContext().record);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0].customer).toBeNull();
  });

  it('a sale on the default customer sends it without its email, and the receipt email still prefills it', async () => {
    saveDefaultCustomer(localStorage, 'https://store.test', { id: 'ada', name: 'Ada Lovelace', email: 'ada@example.com' });
    try {
      vi.mocked(useOutboxContext).mockReturnValue({ ...useOutboxContext(), recent: [] });
      vi.mocked(useReplicatedProducts).mockReturnValue(replicated({ products: [{
        id: 'shirt', title: 'Shirt', status: 'published', variants: [{ id: 'blue', title: 'Blue', sku: 'BLUE',
          prices: [{ amount: 12, currency_code: 'eur' }] }],
      }] }));
      await mount();
      fireEvent.click(screen.getByTestId('product-tile-Shirt'));
      await payByCard();
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Complete sale' })); });
      const record = vi.mocked(useOutboxContext().record);
      expect(record).toHaveBeenCalledTimes(1);
      const sent = record.mock.calls[0][0].customer;
      expect(sent).toMatchObject({ id: 'ada', name: 'Ada Lovelace' });
      expect(sent).not.toHaveProperty('email');
      fireEvent.click(screen.getByTestId('receipt-email-open'));
      expect((screen.getByLabelText('Email Address') as HTMLInputElement).value).toBe('ada@example.com');
    } finally {
      saveDefaultCustomer(localStorage, 'https://store.test', null);
    }
  });

  it('clearing the default never rewrites an open sale', async () => {
    saveDefaultCustomer(localStorage, 'https://store.test', { id: 'ada', name: 'Ada Lovelace', email: 'ada@example.com' });
    vi.mocked(useOutboxContext).mockReturnValue({ ...useOutboxContext(), recent: [] });
    vi.mocked(useReplicatedProducts).mockReturnValue(replicated({ products: [{
      id: 'shirt', title: 'Shirt', status: 'published', variants: [{ id: 'blue', title: 'Blue', sku: 'BLUE',
        prices: [{ amount: 12, currency_code: 'eur' }] }],
    }] }));
    await mount();
    fireEvent.click(screen.getByTestId('product-tile-Shirt'));
    expect(screen.getByRole('button', { name: 'Customer: Ada Lovelace' })).toBeTruthy();
    act(() => {
      forgetDeletedDefaultCustomer(localStorage, 'https://store.test', [{ code: 'customer_ignored', customerId: 'ada' }]);
    });
    expect(loadDefaultCustomer(localStorage, 'https://store.test')).toBeNull();
    expect(screen.getByRole('button', { name: 'Customer: Ada Lovelace' })).toBeTruthy();
  });

  it('shows a stopped product pull above the sales line', async () => {
    vi.mocked(useReplicatedProducts).mockReturnValue(replicated({
      pullNotice: { code: 'unauthorized', since: 0, fixedBy: 'till' },
    }));
    await mount();
    const notice = screen.getByText("Products aren't updating: this till needs to sign in to the online store again.");
    const sales = screen.getByText('Sales are up to date.');
    expect(notice.compareDocumentPosition(sales) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('names the Medusa POS plugin when sales are not reaching the store (#129)', async () => {
    vi.mocked(useOutboxContext).mockReturnValue({ ...useOutboxContext(),
      state: { pending: 1, sending: false, backendMissing: { since: 0 } },
    });
    await mount();
    expect(screen.getByText(/couldn't find the Medusa POS plugin on the online store/)).toBeTruthy();
  });

  it('names the Medusa POS plugin when the product pull reports missing_plugin (#129)', async () => {
    vi.mocked(useReplicatedProducts).mockReturnValue(replicated({
      pullNotice: { code: 'missing_plugin', since: 0, fixedBy: 'store' },
    }));
    await mount();
    expect(screen.getByText("Products aren't updating: the online store is missing the Medusa POS plugin.")).toBeTruthy();
  });

  it('keeps search focusable and editable with the authRequired strip in the title slot, the frame and Sign out live', async () => {
    const { SignInAgain } = await import('../components/sign-in-again');
    vi.mocked(useOutboxContext).mockReturnValue({ ...useOutboxContext(), state: { pending: 1, sending: false, authRequired: true } });
    await mountFramed();
    const setOptions = vi.fn<NonNullable<Parameters<typeof SignInAgain>[0]['header']>['setOptions']>();
    const banner = render(<SessionProvider><SignInAgain header={{ setOptions }} /></SessionProvider>);
    expect(banner.container.textContent).toBe('');
    render(<header>{setOptions.mock.lastCall![0].headerTitle!()}</header>);
    expect(screen.getByText('1 sale saved, waiting to send ·').closest('header')).toBeTruthy();
    const input = screen.getByRole('searchbox') as HTMLInputElement;
    expect(getComputedStyle(input).display).not.toBe('none');
    expect(getComputedStyle(input).visibility).toBe('visible');
    act(() => input.focus());
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: '123456' } });
    expect(input.value).toBe('123456');
    fireEvent.click(within(screen.getByTestId('nav-rail')).getByRole('button', { name: 'Orders' }));
    expect(router.push).toHaveBeenCalledWith('/orders');
    fireEvent.click(signOutButton());
    fireEvent.click(screen.getByTestId('switch-confirm-confirm'));
    expect(localStorage.getItem('medusapos.session')).toBeNull();
  });

  it('keeps the scan box usable with the refused strip in the header title', async () => {
    vi.mocked(useOutboxContext).mockReturnValue({ ...useOutboxContext(), state: { pending: 1, sending: false, refused: { status: 400, reason: 'protocol' } } });
    await mount();
    const setOptions = vi.fn<NonNullable<Parameters<typeof StoreRefused>[0]['header']>['setOptions']>();
    const banner = render(<StoreRefused header={{ setOptions }} />);
    expect(banner.container.textContent).toBe('');
    render(<header>{setOptions.mock.lastCall![0].headerTitle!()}</header>);
    expect(screen.getByText('1 sale not accepted ·').closest('header')).toBeTruthy();
    const input = screen.getByRole('searchbox') as HTMLInputElement;
    act(() => input.focus());
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: '123456' } });
    expect(input.value).toBe('123456');
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(getComputedStyle(screen.getByRole('heading', { name: 'Not accepted by the store' }).parentElement!).position).toBe('absolute');
    expect(setOptions.mock.lastCall![0].headerTitle).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: 'Later' }));
    expect(setOptions.mock.lastCall![0].headerTitle).toBeTypeOf('function');
  });

  it('shows only sign-in when both authRequired and refused are set', async () => {
    vi.mocked(useOutboxContext).mockReturnValue({ ...useOutboxContext(), state: { pending: 1, sending: false, authRequired: true, refused: { status: 400, reason: 'protocol' } } });
    await mount();
    render(<SessionProvider><OutboxStrip>{null}</OutboxStrip></SessionProvider>);
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Details' })).toBeNull();
  });

  it('uses the catalogue layout width for two to six columns with room for 160 px tiles', async () => {
    vi.mocked(useReplicatedProducts).mockReturnValue(replicated({ products: Array.from({ length: 6 }, (_, i) => ({
      id: `p${i}`, title: `Product ${i}`, status: 'published',
      variants: [{ id: `p${i}-v`, title: 'One size', prices: [{ amount: 1, currency_code: 'eur' }] }],
    })) }));
    await mount();
    const pane = screen.getByTestId('catalogue-status-row').parentElement!.parentElement as HTMLElement & {
      __reactLayoutHandler: (event: { nativeEvent: { layout: { width: number } } }) => void;
    };
    expect(screen.getByTestId('product-tile-Product 0').parentElement!.parentElement!.children).toHaveLength(2);
    for (const [width, columns] of [[300, 2], [511, 2], [512, 3], [680, 4], [848, 5], [1016, 6], [1600, 6], [400, 2]]) {
      act(() => pane.__reactLayoutHandler({ nativeEvent: { layout: { width } } }));
      const cell = screen.getByTestId('product-tile-Product 0').parentElement!;
      expect(cell.parentElement!.children).toHaveLength(columns);
      expect(parseFloat(cell.style.width)).toBeCloseTo(100 / columns);
    }
  });
  it('keeps cached sellable products sorted while offline and adds selections to the cart', async () => {
    const product = (id: string, title: string, status = 'published') => ({
      id, title, status, variants: [{ id: `${id}-one`, title: 'One size', sku: id,
        prices: [{ amount: 12.5, currency_code: 'eur' }] }],
    });
    vi.mocked(useReplicatedProducts).mockReturnValue(replicated({
      // SKU "zebra": Enter looks a code up only from the till's minimum scan length (3 by default, ADR 0016).
      products: [product('zebra', 'Zebra'), product('draft', 'Draft', 'draft'), product('a', 'Apple')],
      state: 'offline', error: 'Failed to fetch',
    }));
    await mount();
    expect(screen.getByText('Test shop · Offline · cached catalogue · 2 products · Failed to fetch')).toBeTruthy();
    expect(screen.getAllByRole('button').map((button) => button.getAttribute('data-testid')?.startsWith('product-tile-')
      ? within(button).getByText(/^(Apple|Zebra)$/).textContent : ['user-menu', 'product-settings-button', 'cart-settings-button', 'cart-add-menu', 'customer-chip'].includes(button.dataset.testid ?? '') ? button.getAttribute('aria-label') : button.textContent))
      .toEqual(['Offline', 'Register ›', 'Account: admin@store.test', 'In Stock', 'Product settings', 'Apple', 'Zebra', 'Customer: Guest', 'Add to cart', 'Cart settings', 'Add order note']);
    expect(screen.queryByTestId('cart-checkout')).toBeNull(); // the empty cart draws no foot (TallyUI 3.19.0)
    expect(screen.getByLabelText('Sales are up to date.').textContent).toBe('Sales are up to date.');
    fireEvent.click(screen.getByTestId('product-tile-Apple'));
    expect(cartLineCells('Apple')).toEqual(['1', 'Apple', '€12.50', '€12.50']);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zebra' } });
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Enter' });
    for (const name of ['Zebra', 'Apple']) {
      expect(cartLineCells(name)).toEqual(['1', name, '€12.50', '€12.50']);
    }
  });

  it('publishes the sellable catalogue for the session\'s store to the Products area, and withdraws it on unmount', async () => {
    const product = (id: string, title: string, status = 'published') => ({ id, title, status,
      variants: [{ id: `${id}-one`, title: 'One size', sku: id, prices: [{ amount: 12.5, currency_code: 'eur' }] }] });
    vi.mocked(useReplicatedProducts).mockReturnValue(replicated({
      products: [product('zebra', 'Zebra'), product('draft', 'Draft', 'draft'), product('a', 'Apple')],
    }));
    let seen: ReturnType<typeof useCatalogueSnapshot> | undefined;
    const Probe = () => { seen = useCatalogueSnapshot(); return null; };
    await mount();
    render(<Probe />);
    expect(seen).toMatchObject({ owner: 'sale', baseUrl: 'https://store.test', currency: 'EUR', status: 'ready' });
    expect((seen!.products as { id: string }[]).map(({ id }) => id)).toEqual(['a', 'zebra']);
    cleanup();
    render(<Probe />);
    expect(seen).toBeNull();
  });

  it('starts with In Stock off and toggles out-of-stock product visibility', async () => {
    const products = [
      { id: 'apple', title: 'Apple', status: 'published', variants: [{ id: 'apple-one', title: 'One size',
        manage_inventory: true, inventory_quantity: 5, prices: [{ amount: 12.5, currency_code: 'eur' }] }] },
      { id: 'zebra', title: 'Zebra', status: 'published', variants: [{ id: 'zebra-one', title: 'One size',
        manage_inventory: true, inventory_quantity: 0, prices: [{ amount: 12.5, currency_code: 'eur' }] }] },
    ];
    vi.mocked(useReplicatedProducts).mockReturnValue(replicated({ products }));
    await mount();
    const chip = screen.getByRole('button', { name: 'In Stock', pressed: false });
    expect(screen.getByTestId('product-tile-Apple')).toBeTruthy();
    expect(within(screen.getByTestId('product-tile-Zebra')).getByText('Out of Stock')).toBeTruthy();
    fireEvent.click(chip);
    expect(screen.getByRole('button', { name: 'In Stock', pressed: true })).toBeTruthy();
    expect(screen.getByTestId('product-tile-Apple')).toBeTruthy();
    expect(screen.queryByTestId('product-tile-Zebra')).toBeNull();
    fireEvent.click(chip);
    expect(screen.getByRole('button', { name: 'In Stock', pressed: false })).toBeTruthy();
    expect(screen.getByTestId('product-tile-Apple')).toBeTruthy();
    expect(screen.getByTestId('product-tile-Zebra')).toBeTruthy();
  });

  it.each([
    [undefined, 'Test shop · Up to date · 0 products'],
    [{ count: 0, stale: false }, 'Test shop · Up to date · 0 products'],
    [{ count: 1, stale: false }, 'Test shop · Up to date · 0 products · 1 not sold in this channel'],
    [{ count: 1200, stale: true }, 'Test shop · Up to date · 0 products · 1,200 not sold in this channel (last check failed)'],
  ])('shows the unlisted count %j on the status line', async (unlisted, text) => {
    vi.mocked(useReplicatedProducts).mockReturnValue(replicated({ unlisted }));
    await mount();
    expect(screen.getByText(text)).toBeTruthy();
  });

  it.each([
    [0, 'Test shop · Up to date · 0 products'],
    [1, 'Test shop · Up to date · 1 product'],
    [2, 'Test shop · Up to date · 2 products'],
    [1234, 'Test shop · Up to date · 1,234 products'],
  ])('with %i sellable products the status line reads %j', async (count, text) => {
    const products = Array.from({ length: count }, (_, i) => ({ id: `p${i}`, title: `Product ${i}`, status: 'published',
      variants: [{ id: `p${i}-v`, title: 'One size', sku: `p${i}`, prices: [{ amount: 1, currency_code: 'eur' }] }] }));
    vi.mocked(useReplicatedProducts).mockReturnValue(replicated({ products }));
    await mount();
    expect(screen.getByText(text)).toBeTruthy();
  });

  it('falls back to the connector name when the store name is blank', async () => {
    vi.mocked(fetchStoreSettings).mockResolvedValue({ ...settings, storeName: '' });
    await mount();
    expect(await screen.findByText('MedusaJS · Up to date · 0 products')).toBeTruthy();
  });
  it('says a held unsupported settings result applies after the sale, not "Offline"', async () => {
    vi.mocked(useReplicatedProducts).mockReturnValue(replicated({ products: [{ id: 'shirt', title: 'Shirt', status: 'published',
      variants: [{ id: 'blue', title: 'Blue', sku: 'BLUE', prices: [{ amount: 12, currency_code: 'eur' }] }] }] }));
    const view = await mount();
    fireEvent.click(screen.getByTestId('product-tile-Shirt'));
    vi.mocked(useStoreSettings).mockReturnValue({ state: 'unsupported' });
    await act(async () => { view.rerender(<SessionProvider><ProductsScreen /></SessionProvider>); });
    expect(screen.getByText('Store settings changed; this applies after the current sale')).toBeTruthy();
    expect(screen.queryByText('Offline')).toBeNull();
    expect(cartLineCells('Shirt')).toEqual(['1', 'Shirt', '€12.00', '€12.00']);
  });

  it('shows exactly the three default quick-discount keys in order on the line price keypad', async () => {
    vi.mocked(useReplicatedProducts).mockReturnValue(replicated({ products: [{ id: 'shirt', title: 'Shirt', status: 'published',
      variants: [{ id: 'blue', title: 'Blue', sku: 'BLUE', prices: [{ amount: 12, currency_code: 'eur' }] }] }] }));
    await mount();
    fireEvent.click(screen.getByTestId('product-tile-Shirt'));
    fireEvent.click(within(cartLine('Shirt')).getByTestId('price-popover-trigger'));
    expect(screen.getAllByTestId(/^price-discount-/).map((key) => key.textContent)).toEqual(['−5%', '−10%', '−15%']);
  });

  it('applies the −10% quick discount: €10.80, with the €12.00 regular price struck through', async () => {
    vi.mocked(useReplicatedProducts).mockReturnValue(replicated({ products: [{ id: 'shirt', title: 'Shirt', status: 'published',
      variants: [{ id: 'blue', title: 'Blue', sku: 'BLUE', prices: [{ amount: 12, currency_code: 'eur' }] }] }] }));
    await mount();
    fireEvent.click(screen.getByTestId('product-tile-Shirt'));
    fireEvent.click(within(cartLine('Shirt')).getByTestId('price-popover-trigger'));
    fireEvent.click(screen.getByRole('button', { name: 'Discount (10%)' }));
    fireEvent.click(screen.getByTestId('price-popover-apply'));
    expect(cartLineCells('Shirt')).toEqual(['1', 'Shirt', '€12.00€10.80', '€10.80']);
    expect(within(cartLine('Shirt')).getByLabelText('Regular price €12.00')).toBeTruthy();
  });

  it('shows the outbox status, puts the attention count on the frame\'s Orders and pushes Orders without replacing the route', async () => {
    const order = savedSale();
    vi.mocked(useOutboxContext).mockReturnValue({ ...useOutboxContext(),
      state: { pending: 2, sending: true }, recent: [order, { ...order, id: 'rejected', syncStatus: 'rejected' },
        { ...order, id: 'warned', syncStatus: 'applied', warnings: [{ code: 'total_mismatch', serverMinor: 1000, expectedMinor: 1200 }] }],
    });
    await mountFramed();
    expect(screen.getByLabelText('2 sales waiting to sync').textContent).toBe('2 sales waiting to sync');
    expect(screen.getByText('Sending…')).toBeTruthy();
    expect(screen.getByTestId('nav-item-orders-badge').textContent).toBe('2');
    fireEvent.click(screen.getByTestId('nav-item-orders'));
    expect(router.push).toHaveBeenCalledExactlyOnceWith('/orders');
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('the receipt prints the finalized order reference, not (draft) (TallyUI 3.0.2)', async () => {
    vi.mocked(useReplicatedProducts).mockReturnValue(replicated({ products: [{
      id: 'shirt', title: 'Shirt', status: 'published', variants: [{ id: 'blue', title: 'Blue', sku: 'BLUE',
        prices: [{ amount: 12, currency_code: 'eur' }] }],
    }] }));
    await mount();
    fireEvent.click(screen.getByTestId('product-tile-Shirt'));
    await payByCard();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Complete sale' })); });
    const record = vi.mocked(useOutboxContext().record);
    expect(record).toHaveBeenCalledTimes(1);
    const [finalized] = record.mock.calls[0];
    expect(screen.getByTestId('receipt-order').textContent).toBe(`Order ${finalized.id.slice(-8)}`);
    expect(screen.queryByText(/\(draft\)/)).toBeNull();
    expect(screen.getByText(formatReceiptDate(finalized.createdAt)).textContent)
      .toBe(formatReceiptDate(finalized.createdAt));
  });

  it.each([undefined, 'Alex Shopkeeper'])('records the cashier email and shows the receipt with name %s', async (name) => {
    vi.mocked(useReplicatedProducts).mockReturnValue(replicated({ products: [{
      id: 'shirt', title: 'Shirt', status: 'published', variants: [{ id: 'blue', title: 'Blue', sku: 'BLUE',
        prices: [{ amount: 12, currency_code: 'eur' }] }],
    }] }));
    await mount(true, false, name);
    fireEvent.click(screen.getByTestId('product-tile-Shirt'));
    await payByCard();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Complete sale' })); });
    expect(useOutboxContext().record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      syncStatus: 'pending', totalMinor: 1500, cashierRef: 'admin@store.test',
    }));
    expect(screen.getByRole('button', { name: 'Print receipt' })).toBeTruthy();
    expect(screen.getByText(`Cashier: ${name ?? 'admin@store.test'}`)).toBeTruthy();
  });
});
describe('Product settings sheet', () => {
  const viewKey = 'medusapos.catalogue.https://store.test';
  const settingsKey = 'medusapos.product-settings.https://store.test';
  const click = (id: string) => fireEvent.click(screen.getByTestId(`product-settings-${id}`));
  const tiles = () => screen.queryAllByTestId(/^product-tile-/).map((tile) => tile.dataset.testid);
  const nameAsc = { field: 'name', dir: 'asc' };
  // Every sort button the sheet shows as chosen; all the others are aria-selected="false".
  const selectedSorts = () => screen.getAllByTestId(/^product-settings-sort-/)
    .filter((button) => button.getAttribute('aria-selected') === 'true').map((button) => button.dataset.testid);
  beforeEach(() => {
    vi.mocked(useReplicatedProducts).mockReturnValue(replicated({ products: [
      { id: 'apple', title: 'Apple', status: 'published', categories: [{ id: 'fruit', name: 'Fruit' }],
        variants: [{ id: 'apple-one', title: 'One size', manage_inventory: true, inventory_quantity: 5,
          prices: [{ amount: 5, currency_code: 'eur' }] }] },
      { id: 'zebra', title: 'Zebra', status: 'published', categories: [{ id: 'fruit', name: 'Fruit' }],
        variants: [{ id: 'zebra-one', title: 'One size', manage_inventory: true, inventory_quantity: 0,
          prices: [{ amount: 20, currency_code: 'eur' }] }] },
    ] }));
  });

  it('opens and closes the sheet, switches to Table and shares the catalogue controls and persistence', async () => {
    await mount();
    expect(screen.getByRole('button', { name: 'Product settings' })).toBe(screen.getByTestId('product-settings-button'));
    click('button');
    expect(within(screen.getByTestId('product-settings-sheet')).getByText('Product settings')).toBeTruthy();
    for (const option of screen.getAllByTestId(/^product-settings-(view|columns|sort|variations)-/)) {
      expect(option.hasAttribute('aria-selected')).toBe(true);
    }
    expect(screen.getByTestId('product-settings-sort-name').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('product-settings-sort-asc').getAttribute('aria-selected')).toBe('true');
    click('view-table');
    expect(screen.getByTestId('product-row-apple')).toBeTruthy();
    expect(tiles()).toEqual([]);
    expect(JSON.parse(localStorage.getItem(viewKey)!)).toEqual({ ...DEFAULT_CATALOGUE_VIEW_STATE, view: 'table', sort: nameAsc });
    click('close');
    expect(screen.queryByTestId('product-settings-sheet')).toBeNull();
    fireEvent.click(screen.getByTestId('product-table-sort-price'));
    fireEvent.click(screen.getByTestId('category-nav-fruit'));
    fireEvent.click(screen.getByTestId('view-toggle-grid'));
    click('button');
    expect(screen.getByTestId('product-settings-view-grid').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('product-settings-sort-price').getAttribute('aria-selected')).toBe('true');
    expect(JSON.parse(localStorage.getItem(viewKey)!)).toEqual({ ...DEFAULT_CATALOGUE_VIEW_STATE,
      categoryId: 'fruit', sort: { field: 'price', dir: 'asc' } });
  });

  it('keeps Show out-of-stock products and the In Stock chip inverse in both directions', async () => {
    await mount();
    click('button');
    expect(screen.getByRole('switch', { name: 'Show out-of-stock products', checked: true })).toBeTruthy();
    click('out-of-stock');
    expect(screen.getByRole('button', { name: 'In Stock', pressed: true })).toBeTruthy();
    expect(tiles()).toEqual(['product-tile-Apple']);
    click('close');
    fireEvent.click(screen.getByRole('button', { name: 'In Stock' }));
    click('button');
    expect(screen.getByRole('switch', { name: 'Show out-of-stock products', checked: true })).toBeTruthy();
    expect(tiles()).toEqual(['product-tile-Apple', 'product-tile-Zebra']);
    click('close');
    fireEvent.click(screen.getByRole('button', { name: 'In Stock' }));
    click('button');
    expect(screen.getByRole('switch', { name: 'Show out-of-stock products', checked: false })).toBeTruthy();
    click('out-of-stock');
    expect(screen.getByRole('button', { name: 'In Stock', pressed: false })).toBeTruthy();
  });

  it('sorts grid tiles by Price then Descending and defaults a direction-only selection to Name', async () => {
    await mount();
    click('button');
    click('sort-desc');
    expect(JSON.parse(localStorage.getItem(viewKey)!).sort).toEqual({ field: 'name', dir: 'desc' });
    click('restore');
    click('sort-price');
    expect(tiles()).toEqual(['product-tile-Apple', 'product-tile-Zebra']);
    click('sort-desc');
    expect(tiles()).toEqual(['product-tile-Zebra', 'product-tile-Apple']);
    expect(JSON.parse(localStorage.getItem(viewKey)!).sort).toEqual({ field: 'price', dir: 'desc' });
  });

  it('saves Popover and tile size, then restores defaults while retaining the category', async () => {
    await mount();
    fireEvent.click(screen.getByTestId('category-nav-fruit'));
    click('button');
    click('variations-popover');
    expect(JSON.parse(localStorage.getItem(settingsKey)!)).toEqual({ variations: 'popover' });
    expect(screen.getByTestId('product-settings-variations-popover').getAttribute('aria-selected')).toBe('true');
    click('columns-4');
    expect(JSON.parse(localStorage.getItem(viewKey)!).gridColumns).toBe(4);
    click('view-table');
    click('sort-price');
    click('sort-desc');
    click('out-of-stock');
    click('restore');
    expect(JSON.parse(localStorage.getItem(viewKey)!)).toEqual({ ...DEFAULT_CATALOGUE_VIEW_STATE, categoryId: 'fruit', sort: nameAsc });
    expect(JSON.parse(localStorage.getItem(settingsKey)!)).toEqual({ variations: 'list' });
    expect(screen.getByRole('switch', { name: 'Show out-of-stock products', checked: true })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'In Stock', pressed: false })).toBeTruthy();
    for (const id of ['view-grid', 'columns-auto', 'variations-list']) {
      expect(screen.getByTestId(`product-settings-${id}`).getAttribute('aria-selected')).toBe('true');
    }
    expect(screen.getByTestId('product-settings-sort-price').getAttribute('aria-selected')).toBe('false');
    expect(screen.getByTestId('product-settings-sort-desc').getAttribute('aria-selected')).toBe('false');
    expect(screen.getByTestId('product-settings-sort-name').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('product-settings-sort-asc').getAttribute('aria-selected')).toBe('true');
    expect(tiles()).toEqual(['product-tile-Apple', 'product-tile-Zebra']);
  });

  it('opens a fresh till on Name ascending, as v2 does', async () => {
    await mount();
    click('button');
    expect(selectedSorts()).toEqual(['product-settings-sort-name', 'product-settings-sort-asc']);
    expect(tiles()).toEqual(['product-tile-Apple', 'product-tile-Zebra']);
    expect(localStorage.getItem(viewKey)).toBeNull();
  });

  it('opens a saved view with no sort on Name ascending without rewriting it on mount', async () => {
    localStorage.setItem(viewKey, JSON.stringify({ ...DEFAULT_CATALOGUE_VIEW_STATE, view: 'table' }));
    await mount();
    click('button');
    expect(selectedSorts()).toEqual(['product-settings-sort-name', 'product-settings-sort-asc']);
    expect(JSON.parse(localStorage.getItem(viewKey)!)).toEqual({ ...DEFAULT_CATALOGUE_VIEW_STATE, view: 'table' });
  });

  it('loads a saved sort as saved', async () => {
    localStorage.setItem(viewKey, JSON.stringify({ ...DEFAULT_CATALOGUE_VIEW_STATE, sort: { field: 'price', dir: 'desc' } }));
    await mount();
    expect(tiles()).toEqual(['product-tile-Zebra', 'product-tile-Apple']);
    click('button');
    expect(selectedSorts()).toEqual(['product-settings-sort-price', 'product-settings-sort-desc']);
  });

  it('lands the table header\'s third click back on Name ascending, never no sort', async () => {
    localStorage.setItem(viewKey, JSON.stringify({ ...DEFAULT_CATALOGUE_VIEW_STATE, view: 'table' }));
    await mount();
    fireEvent.click(screen.getByTestId('product-table-sort-name'));
    expect(JSON.parse(localStorage.getItem(viewKey)!).sort).toEqual({ field: 'name', dir: 'desc' });
    fireEvent.click(screen.getByTestId('product-table-sort-name'));
    expect(JSON.parse(localStorage.getItem(viewKey)!).sort).toEqual(nameAsc);
    click('button');
    expect(selectedSorts()).toEqual(['product-settings-sort-name', 'product-settings-sort-asc']);
  });

  it('loads saved preferences, but keeps a phone on the grid and hides View Mode even after restore', async () => {
    setWindowWidth(390, 800);
    localStorage.setItem(viewKey, JSON.stringify({ ...DEFAULT_CATALOGUE_VIEW_STATE, view: 'table', gridColumns: 3, categoryId: 'fruit' }));
    localStorage.setItem(settingsKey, JSON.stringify({ variations: 'popover' }));
    await mount();
    expect(tiles()).toEqual(['product-tile-Apple', 'product-tile-Zebra']);
    click('button');
    expect(screen.queryByText('View Mode')).toBeNull();
    expect(screen.queryByTestId('product-settings-view-table')).toBeNull();
    expect(screen.getByTestId('product-settings-columns-3').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('product-settings-variations-popover').getAttribute('aria-selected')).toBe('true');
    click('restore');
    expect(JSON.parse(localStorage.getItem(viewKey)!)).toEqual({ ...DEFAULT_CATALOGUE_VIEW_STATE, categoryId: 'fruit', view: 'grid', sort: nameAsc });
    expect(tiles()).toEqual(['product-tile-Apple', 'product-tile-Zebra']);
  });
});

afterEach(() => {
  cleanup();
  localStorage.removeItem('medusapos.cart.https://store.test');
  storeConfig.demo = originalDemoMode;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('ProductsScreen cart settings', () => {
  beforeEach(() => { vi.mocked(useReplicatedProducts).mockReturnValue(replicated({ products: [{ id: 'shirt', title: 'Shirt',
    status: 'published', variants: [{ id: 'blue', title: 'Blue', sku: 'BLUE', prices: [{ amount: 12, currency_code: 'eur' }] }] }] })); });

  it('uses the saved quick discounts on the line price keypad', async () => {
    saveCartSettings(localStorage, 'https://store.test', { ...DEFAULT_CART_SETTINGS, quickDiscounts: [20, 30, 40] });
    await mount();
    fireEvent.click(screen.getByTestId('product-tile-Shirt'));
    fireEvent.click(within(cartLine('Shirt')).getByTestId('price-popover-trigger'));
    expect(screen.getAllByTestId(/^price-discount-/).map((key) => key.textContent)).toEqual(['−20%', '−30%', '−40%']);
  });

  it('moves the wide cart left and restores the default right position', async () => {
    setWindowWidth(1024);
    await mount();
    expect(screen.getByTestId('till-panels').style.flexDirection).toBe('row');
    fireEvent.click(screen.getByTestId('cart-settings-button'));
    fireEvent.click(screen.getByTestId('cart-settings-side-left'));
    expect(screen.getByTestId('till-panels').style.flexDirection).toBe('row-reverse');
    expect(screen.getByTestId('cart-settings-side-left').getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByTestId('cart-settings-restore'));
    expect(screen.getByTestId('till-panels').style.flexDirection).toBe('row');
    act(() => setWindowWidth(1280));
  });

  it('moves open orders from below checkout to above the cart header', async () => {
    await mount();
    fireEvent.click(screen.getByTestId('product-tile-Shirt'));
    expect(screen.getByTestId('cart-checkout').compareDocumentPosition(screen.getByTestId('open-sale-tabs'))
      & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(screen.getByTestId('cart-settings-button'));
    fireEvent.click(screen.getByTestId('cart-settings-open-orders-top'));
    expect(screen.getByTestId('open-sale-tabs').compareDocumentPosition(screen.getByTestId('cart-settings-button'))
      & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('rejects zero as a quick discount and keeps the keypad keys unchanged', async () => {
    await mount();
    fireEvent.click(screen.getByTestId('product-tile-Shirt'));
    fireEvent.click(screen.getByTestId('cart-settings-button'));
    fireEvent.click(screen.getByTestId('cart-settings-discount-1'));
    fireEvent.change(screen.getByLabelText('Quick discount 1'), { target: { value: '0' } });
    fireEvent.keyDown(screen.getByLabelText('Quick discount 1'), { key: 'Enter' });
    expect(screen.getByRole('alert').textContent).toBe('Quick discounts must be three whole numbers from 1 to 100.');
    expect(screen.getByTestId('cart-settings-discount-1').textContent).toBe('−5%');
    fireEvent.click(screen.getByTestId('cart-settings-close'));
    fireEvent.click(within(cartLine('Shirt')).getByTestId('price-popover-trigger'));
    expect(screen.getAllByTestId(/^price-discount-/).map((key) => key.textContent)).toEqual(['−5%', '−10%', '−15%']);
  });

  it('shows the quick discounts as keys and saves an edited key on Enter', async () => {
    await mount();
    fireEvent.click(screen.getByTestId('cart-settings-button'));
    expect(screen.getAllByTestId(/^cart-settings-discount-/).map((key) => key.textContent)).toEqual(['−5%', '−10%', '−15%']);
    expect(screen.queryByLabelText('Quick discount 1')).toBeNull();
    fireEvent.click(screen.getByTestId('cart-settings-discount-2'));
    const field = screen.getByLabelText('Quick discount 2') as HTMLInputElement;
    expect(field.value).toBe('10');
    fireEvent.change(field, { target: { value: '25' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(screen.queryByLabelText('Quick discount 2')).toBeNull();
    expect(screen.getByTestId('cart-settings-discount-2').textContent).toBe('−25%');
    fireEvent.click(screen.getByTestId('cart-settings-close'));
    fireEvent.click(screen.getByTestId('product-tile-Shirt'));
    fireEvent.click(within(cartLine('Shirt')).getByTestId('price-popover-trigger'));
    expect(screen.getAllByTestId(/^price-discount-/).map((key) => key.textContent)).toEqual(['−5%', '−25%', '−15%']);
  });

  it('saves an edited quick discount when the field loses focus', async () => {
    await mount();
    fireEvent.click(screen.getByTestId('cart-settings-button'));
    fireEvent.click(screen.getByTestId('cart-settings-discount-3'));
    fireEvent.change(screen.getByLabelText('Quick discount 3'), { target: { value: '40' } });
    fireEvent.blur(screen.getByLabelText('Quick discount 3'));
    expect(screen.getByTestId('cart-settings-discount-3').textContent).toBe('−40%');
    expect(loadCartSettings(localStorage, 'https://store.test').quickDiscounts).toEqual([5, 10, 40]);
  });

  it('closes from the title X and lays the footer out as v2 does', async () => {
    await mount();
    fireEvent.click(screen.getByTestId('cart-settings-button'));
    fireEvent.click(screen.getByTestId('cart-settings-x'));
    expect(screen.queryByTestId('cart-settings-sheet')).toBeNull();
    fireEvent.click(screen.getByTestId('cart-settings-button'));
    expect(screen.getByTestId('cart-settings-restore').compareDocumentPosition(screen.getByTestId('cart-settings-close'))
      & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  const heads = () => screen.getAllByRole('columnheader').map((head) => head.textContent);
  const column = (id: string) => screen.getByTestId(`cart-settings-column-${id}`);
  const DEFAULT_SWITCHES = { quantity: 'true', 'quantity-split': 'false', image: 'false', name: 'true', 'name-sku': 'false',
    sku: 'false', price: 'true', total: 'true' };
  const switches = () => Object.fromEntries(Object.keys(DEFAULT_SWITCHES).map((id) => [id, column(id).getAttribute('aria-checked')]));

  it('shows the Columns switches with v2 defaults', async () => {
    await mount();
    fireEvent.click(screen.getByTestId('cart-settings-button'));
    expect(screen.getByText('Columns')).toBeTruthy();
    expect(switches()).toEqual(DEFAULT_SWITCHES);
  });

  it('shows a SKU column and hides the Total column, and saves both', async () => {
    await mount();
    fireEvent.click(screen.getByTestId('product-tile-Shirt'));
    expect(heads()).not.toContain('SKU');
    expect(within(cartLine('Shirt')).queryByText('BLUE')).toBeNull();
    fireEvent.click(screen.getByTestId('cart-settings-button'));
    fireEvent.click(column('sku'));
    expect(heads()).toContain('SKU');
    expect(within(cartLine('Shirt')).getByText('BLUE')).toBeTruthy();
    fireEvent.click(column('total'));
    expect(heads()).not.toContain('Total');
    expect(loadCartSettings(localStorage, 'https://store.test').columns)
      .toEqual({ ...DEFAULT_CART_SETTINGS.columns, sku: { show: true }, total: { show: false } });
  });

  it('shows the SKU under the line name', async () => {
    await mount();
    fireEvent.click(screen.getByTestId('product-tile-Shirt'));
    expect(within(cartLine('Shirt')).queryByTestId('cart-line-sku')).toBeNull();
    fireEvent.click(screen.getByTestId('cart-settings-button'));
    fireEvent.click(column('name-sku'));
    expect(within(cartLine('Shirt')).getByTestId('cart-line-sku').textContent).toBe('BLUE');
  });

  it('restores the default columns', async () => {
    await mount();
    fireEvent.click(screen.getByTestId('product-tile-Shirt'));
    const defaults = heads();
    fireEvent.click(screen.getByTestId('cart-settings-button'));
    fireEvent.click(column('image'));
    fireEvent.click(column('price'));
    expect(heads()).not.toEqual(defaults);
    fireEvent.click(screen.getByTestId('cart-settings-restore'));
    expect(heads()).toEqual(defaults);
    expect(switches()).toEqual(DEFAULT_SWITCHES);
  });

  const sheetSide = () => screen.getByTestId('cart-settings-sheet').getAttribute('data-side');

  it('opens Cart Settings from the left, over the products, on a wide till', async () => {
    await mount();
    fireEvent.click(screen.getByTestId('cart-settings-button'));
    expect(sheetSide()).toBe('left');
  });

  it('opens Cart Settings from the right when the cart is on the left', async () => {
    await mount();
    fireEvent.click(screen.getByTestId('cart-settings-button'));
    fireEvent.click(screen.getByTestId('cart-settings-side-left'));
    expect(sheetSide()).toBe('right');
    fireEvent.click(screen.getByTestId('cart-settings-restore'));
    expect(sheetSide()).toBe('left');
  });

  it('keeps Cart Settings on the right on a phone', async () => {
    setWindowWidth(390, 844);
    await mount();
    fireEvent.click(screen.getByRole('tab', { name: /^Cart, / }));
    fireEvent.click(screen.getByTestId('cart-settings-button'));
    expect(sheetSide()).toBe('right');
  });

  // Three products, added Zebra, Apple, Mango: the cart's lines in DOM order, read from their quantity triggers.
  const fruit = (id: string, title: string, amount: number) => ({ id, title, status: 'published',
    variants: [{ id: `${id}-one`, title: 'One size', sku: id, prices: [{ amount, currency_code: 'eur' }] }] });
  async function addFruit() {
    vi.mocked(useReplicatedProducts).mockReturnValue(replicated({ products: [fruit('zebra', 'Zebra', 3), fruit('apple', 'Apple', 5),
      fruit('mango', 'Mango', 1)] }));
    await mount();
    for (const title of ['Zebra', 'Apple', 'Mango']) fireEvent.click(screen.getByTestId(`product-tile-${title}`));
  }
  const lineOrder = () => screen.getAllByRole('button', { name: /^Edit quantity of / })
    .map((button) => button.getAttribute('aria-label')!.replace('Edit quantity of ', ''));

  it('shows the cart lines in the order added by default', async () => {
    await addFruit();
    expect(lineOrder()).toEqual(['Zebra', 'Apple', 'Mango']);
  });

  it('shows the cart lines in name order when Sort items is Name', async () => {
    saveCartSettings(localStorage, 'https://store.test', { ...DEFAULT_CART_SETTINGS, sortItems: 'name' });
    await addFruit();
    expect(lineOrder()).toEqual(['Apple', 'Mango', 'Zebra']);
  });

  it('shows Sort items with the saved choice, Newest at bottom by default', async () => {
    await mount();
    fireEvent.click(screen.getByTestId('cart-settings-button'));
    expect(screen.getByTestId('cart-settings-sort-items').textContent).toBe('Newest at bottom');
    cleanup();
    saveCartSettings(localStorage, 'https://store.test', { ...DEFAULT_CART_SETTINGS, sortItems: 'name' });
    await mount();
    fireEvent.click(screen.getByTestId('cart-settings-button'));
    expect(screen.getByTestId('cart-settings-sort-items').textContent).toBe('Name');
  });

  it('saves Name from the Sort items select and re-orders the cart lines', async () => {
    await addFruit();
    fireEvent.click(screen.getByTestId('cart-settings-button'));
    fireEvent.click(screen.getByTestId('cart-settings-sort-items'));
    expect(screen.getAllByTestId(/^cart-settings-sort-(?!items)/).map((item) => item.textContent))
      .toEqual(['Newest at bottom', 'Newest at top', 'Name', 'Price']);
    fireEvent.click(screen.getByTestId('cart-settings-sort-name'));
    expect(loadCartSettings(localStorage, 'https://store.test').sortItems).toBe('name');
    expect(screen.getByTestId('cart-settings-sort-items').textContent).toBe('Name');
    expect(lineOrder()).toEqual(['Apple', 'Mango', 'Zebra']);
  });

  it('restores Sort items to Newest at bottom', async () => {
    saveCartSettings(localStorage, 'https://store.test', { ...DEFAULT_CART_SETTINGS, sortItems: 'name' });
    await mount();
    fireEvent.click(screen.getByTestId('cart-settings-button'));
    fireEvent.click(screen.getByTestId('cart-settings-restore'));
    expect(loadCartSettings(localStorage, 'https://store.test').sortItems).toBe('newest-bottom');
    expect(screen.getByTestId('cart-settings-sort-items').textContent).toBe('Newest at bottom');
  });
});

async function mount(signedIn = true, orders = false, name?: string, email = 'admin@store.test', framed = false) {
  if (signedIn) saveSession(localStorage, {
    baseUrl: 'https://store.test', email, name,
    token: `header.${btoa(JSON.stringify({ exp: Date.now() / 1000 + 86400 }))}.signature`,
  });
  const page = orders ? <OrdersScreen /> : <ProductsScreen />;
  let view!: ReturnType<typeof render>;
  await act(async () => { view = render(<SessionProvider>{framed ? <AppFrame signedIn>{page}</AppFrame> : page}<PortalHost /></SessionProvider>); });
  return view;
}
// As _layout.tsx renders the sale: under the app frame, on the wide window beforeEach sets (the rail).
const mountFramed = () => mount(true, false, undefined, undefined, true);
function signOutButton(description?: string) {
  if (!screen.queryByTestId('user-sheet')) fireEvent.click(screen.getByTestId('user-menu'));
  return screen.getByRole('button', { name: 'Sign out', ...(description ? { description } : {}) });
}
function openMenu(name: string) {
  fireEvent.click(screen.getByTestId('cart-add-menu'));
  fireEvent.click(screen.getByRole('menuitem', { name }));
}

function savedSale(): PosOrder {
  const builder = createOrderBuilder({ currency: 'EUR', taxContext: { pricesIncludeTax: false, getTaxRatePpm: () => 0 } });
  builder.addLine({ productId: 'shirt', variantId: 'blue', name: 'Blue shirt', unitPrice: { amount: 1200, currency: 'EUR' } });
  builder.addPayment({ method: 'cash', amountMinor: 1200 });
  return finalizeOrder(builder.getSnapshot());
}

describe('Orders screen and sync status', () => {
  it('shows only Recent when no orders need attention', async () => {
    const order = savedSale();
    vi.mocked(useOutboxContext).mockReturnValue({ ...useOutboxContext(), recent: [
      order, { ...order, id: 'applied', syncStatus: 'applied', warnings: [] },
    ] });
    await mount(true, true);
    expect(screen.getAllByRole('heading').map((heading) => heading.textContent)).toEqual(['Recent']);
    expect(screen.queryByRole('link', { name: 'Send feedback' })).toBeNull();
  });
  it('lists attention first, including errors, both warnings, totals and server display IDs', async () => {
    const order = savedSale();
    vi.mocked(useOutboxContext).mockReturnValue({ ...useOutboxContext(), recent: [
      { ...order, id: 'rejected', syncStatus: 'rejected', error: { code: 'invalid', message: 'Unknown variant' } },
      { ...order, id: 'warned', syncStatus: 'applied', serverRefs: { orderId: 'server', displayId: '42', totalMinor: 1000 },
        lines: order.lines.map((line) => ({ ...line, quantity: 3 })),
        warnings: [{ code: 'insufficient_stock', variantId: 'blue', quantity: 2 },
          { code: 'total_mismatch', serverMinor: 1000, expectedMinor: 1200 }] }, order,
    ] });
    await mount(true, true);
    expect(screen.getAllByRole('heading').map((heading) => heading.textContent)).toEqual(['Needs attention', 'Recent']);
    for (const label of ["The online store refused this sale. Ask the store owner to look at the till's sync log.", '2 sold without stock: Blue shirt', 'Store total €10.00 vs POS €12.00', 'Order warned · #42 · 3 items']) {
      expect(screen.getAllByText(label)).toHaveLength(2);
    }
    expect(screen.getAllByText('Order rejected · 1 item')).toHaveLength(2);
    expect(screen.getAllByText(`Order ${order.id.slice(-8)} · 1 item`)).toHaveLength(1);
    const dateAndTotal = `${new Date(order.createdAt).toLocaleString()} · €12.00`;
    expect(screen.getByText(`${dateAndTotal} · Waiting to sync`)).toBeTruthy();
    expect(screen.getAllByText(`${dateAndTotal} · Synced`)).toHaveLength(2);
    expect(screen.getAllByText(`${dateAndTotal} · Not accepted`)).toHaveLength(2);
  });

  it.each(['invalid', 'idempotency_mismatch', 'warnings'])('offers Retry only for requeueable rejections: %s', async (kind) => {
    const order = savedSale();
    const recent: PosOrder[] = [kind === 'warnings'
      ? { ...order, syncStatus: 'applied', warnings: [{ code: 'total_mismatch', serverMinor: 1000, expectedMinor: 1200 }] }
      : { ...order, syncStatus: 'rejected', error: { code: kind, message: 'Rejected' } }];
    const requeue = vi.fn().mockResolvedValue(1);
    vi.mocked(useOutboxContext).mockReturnValue({ ...useOutboxContext(), recent, requeue });
    await mount(true, true);
    if (kind === 'invalid') {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      expect(requeue).toHaveBeenCalledExactlyOnceWith([order.id]);
    } else {
      expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
      expect(requeue).not.toHaveBeenCalled();
    }
    // In both Needs attention and Recent (#314).
    expect(screen.queryAllByText("The online store has a different sale under this sale's number. Don't send it again; ask the store owner to compare the two."))
      .toHaveLength(kind === 'idempotency_mismatch' ? 2 : 0);
  });

  it.each([0, 1])('blocks repeat Retry taps until requeue resolves %s or the order leaves rejected', async (result) => {
    const order: PosOrder = { ...savedSale(), syncStatus: 'rejected' };
    let resolve!: (count: number) => void;
    const requeue = vi.fn(() => new Promise<number>((done) => { resolve = done; }));
    vi.mocked(useOutboxContext).mockReturnValue({ ...useOutboxContext(), recent: [order], requeue });
    await mount(true, true);
    const retry = screen.getByRole('button', { name: 'Retry' });
    act(() => { fireEvent.click(retry); fireEvent.click(retry); });
    expect(requeue).toHaveBeenCalledExactlyOnceWith([order.id]);
    expect(retry.getAttribute('aria-disabled')).toBe('true');
    await act(async () => { resolve(result); });
    expect(retry.getAttribute('aria-disabled')).toBe(result === 0 ? null : 'true');
    fireEvent.click(retry);
    expect(requeue).toHaveBeenCalledTimes(result === 0 ? 2 : 1);
  });

  it.each(['pending', 'applied'] as const)('clears Retry state when the outbox reports %s', async (syncStatus) => {
    const order: PosOrder = { ...savedSale(), syncStatus: 'rejected' };
    const requeue = vi.fn().mockResolvedValue(1);
    vi.mocked(useOutboxContext).mockReturnValue({ ...useOutboxContext(), recent: [order], requeue });
    const view = await mount(true, true);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    vi.mocked(useOutboxContext).mockReturnValue({ ...useOutboxContext(), recent: [{ ...order, syncStatus }] });
    view.rerender(<SessionProvider><OrdersScreen /></SessionProvider>);
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    vi.mocked(useOutboxContext).mockReturnValue({ ...useOutboxContext(), recent: [order] });
    view.rerender(<SessionProvider><OrdersScreen /></SessionProvider>);
    expect(screen.getByRole('button', { name: 'Retry' }).getAttribute('aria-disabled')).toBeNull();
  });

  it('redirects Orders to login when signed out', async () => {
    await mount(false, true);
    expect(screen.getByText('redirect:/login')).toBeTruthy();
    expect(screen.queryByText('Recent')).toBeNull();
  });

  it('shows retry seconds and updates the countdown', () => {
    vi.useFakeTimers();
    try {
      render(<SyncStatus state={{ pending: 1, sending: false, lastRetryReason: 'network', nextAttemptAt: Date.now() + 3000 }} />);
      expect(screen.getByLabelText('1 sale waiting to sync').textContent).toBe('1 sale waiting to sync');
      expect(screen.getByText('Retrying in 3 s.')).toBeTruthy();
      act(() => { vi.advanceTimersByTime(1000); });
      expect(screen.getByText('Retrying in 2 s.')).toBeTruthy();
      expect(screen.queryByText('Retrying in 3 s.')).toBeNull();
      cleanup();
    } finally { vi.useRealTimers(); }
  });
});

describe('ProductsScreen live stock', () => {
  const item = (id: string, stocked: number) => ({ inventory_item_id: id, required_quantity: 1,
    inventory: { location_levels: [{ stocked_quantity: stocked, reserved_quantity: 0 }] } });
  const shirt = { id: 'shirt', title: 'Shirt', status: 'published', variants: [
    { id: 'small', title: 'Small', sku: 'S', prices: [], manage_inventory: true, inventory_items: [item('inv-small', 0)] },
    { id: 'large', title: 'Large', sku: 'L', prices: [], manage_inventory: true, inventory_items: [item('inv-large', 4)] },
  ] };

  it('reads stock from the overlay before the replicated product', async () => {
    const pass = new Date('2026-09-24T10:42:00Z');
    vi.mocked(useReplicatedProducts).mockReturnValue(replicated({ products: [shirt], lastSyncedAt: new Date(0),
      lastStockCheckAt: pass, stockOverlay: new Map([
        ['inv-small', [{ stocked_quantity: 3, reserved_quantity: 0 }]],
        ['inv-large', [{ stocked_quantity: 2, reserved_quantity: 2 }]],
      ]) }));
    await mount();
    fireEvent.click(screen.getByTestId('product-tile-Shirt'));
    const asOf = `as of ${formatStockSyncTime(pass)}`;
    expect(screen.getByRole('button', { name: /Small/ }).textContent).toContain(`In Stock · ${asOf}`);
    expect(screen.getByRole('button', { name: /Large/ }).textContent).toContain(`Out of Stock · ${asOf}`);
  });

  it('reconciles stock once for each applied order with a new insufficient_stock warning', async () => {
    const short: PosOrder = { ...savedSale(), syncStatus: 'applied',
      warnings: [{ code: 'insufficient_stock', variantId: 'blue', quantity: 2 }] };
    const outbox = useOutboxContext();
    vi.mocked(useOutboxContext).mockReturnValue({ ...outbox, recent: [short, { ...short, id: 'queued', syncStatus: 'pending' }] });
    const view = await mount();
    expect(reconcileStock).toHaveBeenCalledTimes(1);
    vi.mocked(useOutboxContext).mockReturnValue({ ...outbox, recent: [{ ...short }] });
    view.rerender(<SessionProvider><ProductsScreen /></SessionProvider>);
    expect(reconcileStock).toHaveBeenCalledTimes(1);
  });
});

describe('ProductsScreen sale layout (ADR 0009)', () => {
  const button = (name: string | RegExp) => screen.getByRole('button', { name });
  const search = () => screen.queryByRole('searchbox');
  beforeEach(() => { vi.mocked(useReplicatedProducts).mockReturnValue(replicated({ products: [{ id: 'shirt', title: 'Shirt',
    status: 'published', variants: [{ id: 'blue', title: 'Blue', sku: 'BLUE', prices: [{ amount: 12, currency_code: 'eur' }] }] }] })); });

  it('at 390 wide the tender is titled Checkout Order and its close returns to the cart', async () => {
    setWindowWidth(390, 844);
    await mount();
    fireEvent.click(screen.getByTestId('product-tile-Shirt'));
    fireEvent.click(screen.getByRole('tab', { name: /^Cart, / }));
    await checkout();
    expect(screen.getByTestId('screen-title').getAttribute('data-title')).toBe('Checkout Order');
    expect(screen.queryByTestId('user-menu')).toBeNull();
    const close = screen.getByTestId('tender-close');
    expect(button('Close')).toBe(close);
    act(() => { fireEvent.click(close); });
    expect(screen.queryByRole('button', { name: 'Complete sale' })).toBeNull();
    expect(cartLineCells('Shirt')).toEqual(['1', 'Shirt', '€12.00']);
    expect(screen.getByTestId('screen-title').getAttribute('data-title')).toBe('Test shop · Register 1');
    expect(screen.queryByTestId('tender-close')).toBeNull();
    expect(screen.getByTestId('user-menu')).toBeTruthy();
  });

  it('at 1280 wide the title names the store and register, through the tender, with no close', async () => {
    await mount();
    expect(screen.getByTestId('screen-title').getAttribute('data-title')).toBe('Test shop · Register 1');
    fireEvent.click(screen.getByTestId('product-tile-Shirt'));
    await checkout();
    expect(button('Complete sale')).toBeTruthy();
    expect(screen.getByTestId('screen-title').getAttribute('data-title')).toBe('Test shop · Register 1');
    expect(screen.queryByTestId('tender-close')).toBeNull();
    expect(screen.getByTestId('user-menu')).toBeTruthy();
  });

  it('at 1280 wide the title falls back to the connector name when the store name is blank', async () => {
    const { createPosConnector } = await import('../lib/pos-connector');
    vi.mocked(fetchStoreSettings).mockResolvedValue({ ...settings, storeName: '' });
    await mount();
    expect(screen.getByTestId('screen-title').getAttribute('data-title')).toBe(`${createPosConnector().name} · Register 1`);
  });

  it('at 360 wide adds stay on Products, the Cart tab opens the cart, Products returns, and tender and new sale take over', async () => {
    setWindowWidth(360);
    await mount();
    expect(screen.getByRole('tab', { name: 'Cart, New' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Products' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByTestId('product-tile-Shirt'));
    expect(screen.getByRole('tab', { name: 'Cart, 1 item' })).toBeTruthy();
    expect(screen.getByTestId('phone-tab-cart-count').textContent).toBe('1');
    fireEvent.click(screen.getByTestId('product-tile-Shirt'));
    expect(screen.getByRole('tab', { name: 'Cart, 2 items' })).toBeTruthy();
    expect(screen.getByTestId('phone-tab-cart-count').textContent).toBe('2');
    expect(search()).toBeTruthy();
    expect(screen.queryByTestId('cart-checkout')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: /^Cart, / }));
    expect(cartLineCells('Shirt')).toEqual(['2', 'Shirt', '€24.00']);
    expect(search()).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Products' }));
    expect(search()).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Cart, 2 items' }));
    expect(cartLineCells('Shirt')).toEqual(['2', 'Shirt', '€24.00']);
    await checkout();
    expect(button('Complete sale')).toBeTruthy();
    expect(screen.queryByTestId('phone-tab-bar')).toBeNull();
    // TallyUI 3.14.0's tender pane has its own Cash tile: the one Cash button left is the pane's, the cart's pay button is gone.
    expect(button('Cash').closest('[data-testid="tender-pane"]')).toBeTruthy();
    expect(search()).toBeNull();
    expect(screen.queryByTestId('cart-checkout')).toBeNull();
    fireEvent.click(button('Back'));
    await payByCard();
    await act(async () => { fireEvent.click(button('Complete sale')); });
    fireEvent.click(button('New sale'));
    expect(screen.getByRole('tab', { name: 'Cart, New' })).toBeTruthy();
    expect(search()).toBeTruthy();
  }, 15000);

  // v2's phone header (row 17a.2): the store and register on Products and Cart, the register state only when not open.
  const title = () => screen.getByTestId('screen-title').getAttribute('data-title');
  const tab = (name: RegExp) => screen.getByRole('tab', { name });

  it('at 360 wide with an open register the title names the store and register on both tabs, with no register state', async () => {
    setWindowWidth(360);
    await mount();
    expect(title()).toBe('Test shop · Register 1');
    fireEvent.click(tab(/^Cart/));
    expect(tab(/^Cart/).getAttribute('aria-selected')).toBe('true');
    expect(title()).toBe('Test shop · Register 1');
    expect(screen.queryByTestId('header-register-state')).toBeNull();
    expect(screen.getByTestId('user-menu')).toBeTruthy();
  });

  it('at 360 wide with a closed register the header shows Closed, and pressing it opens the Cart tab', async () => {
    // A finished close leaves no session (sessions still enabled); a session whose status is 'closed' is "Close not finished".
    const fixture = openRegisterFixture({ enabled: true });
    vi.mocked(useRegister).mockReturnValue({ ...fixture, register: { ...fixture.register, session: null } });
    setWindowWidth(360);
    await mount();
    const control = screen.getByTestId('header-register-state');
    expect(control.textContent).toBe('Closed');
    expect(screen.getByRole('button', { name: 'Register: Closed' })).toBe(control);
    // A closed register opens the cart on a phone by itself, so go back to Products first: the press must bring it back.
    fireEvent.click(tab(/^Products/));
    expect(tab(/^Cart/).getAttribute('aria-selected')).toBe('false');
    act(() => { fireEvent.click(control); });
    expect(tab(/^Cart/).getAttribute('aria-selected')).toBe('true');
  });

  it('at 360 wide with a session still closed the header reads Close not finished, as the wide header does', async () => {
    const fixture = openRegisterFixture();
    vi.mocked(useRegister).mockReturnValue({ ...fixture,
      register: { ...fixture.register, session: { ...fixture.register.session!, status: 'closed' } } });
    setWindowWidth(360);
    await mount();
    expect(screen.getByTestId('header-register-state').textContent).toBe('Close not finished');
  });

  it('at 360 wide with no register chosen the header reads Choose register', async () => {
    vi.mocked(useRegister).mockReturnValue({ ...openRegisterFixture(), boundRegisterId: null });
    setWindowWidth(360);
    await mount();
    expect(screen.getByTestId('header-register-state').textContent).toBe('Choose register');
    expect(screen.getByRole('button', { name: 'Choose register' })).toBe(screen.getByTestId('header-register-state'));
  });

  it('at 1280 wide shows the catalogue and cart with no bar; the discount opens from the menu and pay is pinned', async () => {
    await mount();
    fireEvent.click(screen.getByTestId('product-tile-Shirt'));
    expect(search()).toBeTruthy();
    expect(screen.queryByTestId('phone-tab-bar')).toBeNull();
    // CartPanel's scroll region isn't a separate testID; the footer comes after the last line.
    const lastLine = cartLine('Shirt');
    expect(cartLineCells('Shirt')).toEqual(['1', 'Shirt', '€12.00', '€12.00']);
    expect(lastLine.compareDocumentPosition(screen.getByTestId('cart-footer')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    openMenu('Add Discount');
    fireEvent.click(within(screen.getByTestId('cart-add-dialog')).getByRole('button', { name: 'Cancel' }));
    const footer = within(screen.getByTestId('cart-footer'));
    expect(footer.getByTestId('cart-checkout').textContent).toBe('Checkout €15.00');
    expect(footer.getByText('Total').parentElement!.textContent).toBe('Total€15.00');
    // The ⋮ beside Checkout holds Void while the sale has lines and no payments.
    fireEvent.click(footer.getByRole('button', { name: 'More actions' }));
    expect(within(footer.getByTestId('cart-foot-menu')).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Void']);
  });
});

// v2's header "● Offline": the browser's offline event shows it at once, before any pull fails.
describe('ProductsScreen network offline header', () => {
  const setOnLine = (value: boolean) => Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => value });
  const goNetwork = (online: boolean) => act(() => { setOnLine(online); window.dispatchEvent(new Event(online ? 'online' : 'offline')); });
  const headerState = () => screen.queryByTestId('header-register-state');
  const statusLine = () => screen.getByTestId('catalogue-status-row').textContent;
  // jsdom's own getter is on Navigator.prototype; dropping the instance override restores it.
  afterEach(() => { delete (window.navigator as { onLine?: boolean }).onLine; });

  it('wide: going offline shows Offline with the sales to send and the cached catalogue, and coming back clears both', async () => {
    vi.mocked(useOutboxContext).mockReturnValue({ ...useOutboxContext(), state: { pending: 2, sending: false } });
    await mount();
    expect(headerState()).toBeNull();
    expect(statusLine()).toContain('Up to date');
    goNetwork(false);
    expect(headerState()?.textContent).toBe('Offline · 2 sales to send');
    expect(statusLine()).toContain('Offline · cached catalogue');
    goNetwork(true);
    expect(headerState()).toBeNull();
    expect(statusLine()).toContain('Up to date');
  });

  it('phone: going offline with nothing to send shows Offline in the header', async () => {
    setWindowWidth(360);
    await mount();
    expect(headerState()).toBeNull();
    goNetwork(false);
    expect(headerState()?.textContent).toBe('Offline');
  });

  it('a till that starts with no network shows Offline in the wide header straight away', async () => {
    setOnLine(false);
    await mount();
    expect(within(screen.getByTestId('wide-header-register')).getByTestId('header-register-state').textContent).toBe('Offline');
  });

  // v2's "Device went offline" toast: after CONNECTIVITY_SETTLE_MS (5 s), closable, back after the next outage.
  const toast = () => screen.queryByTestId('offline-toast');
  it('wide: the offline toast shows after 5 s offline, closes, and shows again after the next outage', async () => {
    await mount();
    vi.useFakeTimers();
    try {
      goNetwork(false);
      expect(toast()).toBeNull();
      act(() => { vi.advanceTimersByTime(5_000); });
      expect(toast()?.textContent).toContain('Device went offline');
      expect(headerState()?.textContent).toBe('Offline');
      fireEvent.click(screen.getByTestId('offline-toast-close'));
      expect(toast()).toBeNull();
      goNetwork(true);
      goNetwork(false);
      expect(toast()).toBeNull();
      act(() => { vi.advanceTimersByTime(5_000); });
      expect(toast()?.textContent).toContain('Device went offline');
      cleanup();
    } finally { vi.useRealTimers(); }
  });

  it('wide: with the network up but the pull offline, the toast reads Website is unreachable after 5 s', async () => {
    vi.mocked(useReplicatedProducts).mockReturnValue(replicated({ state: 'offline' }));
    // The outage starts with the screen, so the clock is faked before mount.
    vi.useFakeTimers();
    try {
      await mount();
      expect(toast()).toBeNull();
      act(() => { vi.advanceTimersByTime(5_000); });
      expect(toast()?.textContent).toContain('Website is unreachable');
      cleanup();
    } finally { vi.useRealTimers(); }
  });
});

describe('ProductsScreen session routing', () => {
  it('redirects to login without a session', async () => {
    await mount(false);
    expect(screen.getByText('redirect:/login')).toBeTruthy();
    expect(useReplicatedProducts).not.toHaveBeenCalled();
  });
  it('clears the session and redirects to login when Sign out is pressed', async () => {
    await mount();
    fireEvent.click(signOutButton());
    fireEvent.click(screen.getByTestId('switch-confirm-confirm'));
    expect(localStorage.getItem('medusapos.session')).toBeNull();
    // The screen's own <Redirect href="/login">, with no extra navigation.
    expect(screen.getByText('redirect:/login')).toBeTruthy();
    expect(router.replace).not.toHaveBeenCalled();
  });
  it('a demo account lands back on /demo after Sign out (#196)', async () => {
    storeConfig.demo = true;
    await mount(true, false, undefined, 'cashier@demo.medusapos.com');
    fireEvent.click(signOutButton());
    fireEvent.click(screen.getByTestId('switch-confirm-confirm'));
    expect(localStorage.getItem('medusapos.session')).toBeNull();
    expect(screen.getByText('redirect:/demo')).toBeTruthy();
  });
  it('a demo email on a non-demo build still lands on /login (#196)', async () => {
    storeConfig.demo = false;
    await mount(true, false, undefined, 'cashier@demo.medusapos.com');
    fireEvent.click(signOutButton());
    fireEvent.click(screen.getByTestId('switch-confirm-confirm'));
    expect(screen.getByText('redirect:/login')).toBeTruthy();
  });
  it('signs out when product replication reports unauthorized', async () => {
    await mount();
    const [, context, onUnauthorized] = vi.mocked(useReplicatedProducts).mock.calls[0];
    expect({ ...context.headers }).toEqual({ Authorization: 'Bearer ' + JSON.parse(localStorage.getItem('medusapos.session')!).token });
    expect(context).toMatchObject({ connectorId: 'medusa', baseUrl: 'https://store.test', pricingContext: pricing.pricingContext });
    act(() => onUnauthorized());
    expect(localStorage.getItem('medusapos.session')).toBeNull();
    expect(screen.getByText('redirect:/login')).toBeTruthy();
    expect(screen.queryByTestId('user-menu')).toBeNull();
  });
});

// Sign out unmounts the sale and closes the outbox, so it waits for a pending save (the #150 review).
// outbox.test.tsx covers the same lock on the real outbox.
describe('ProductsScreen Sign out while a sale is saving', () => {
  const SALE_SAVING = 'This sale is being saved. Retry to finish it.';
  beforeEach(() => { vi.mocked(useReplicatedProducts).mockReturnValue(replicated({ products: [{ id: 'shirt', title: 'Shirt',
    status: 'published', variants: [{ id: 'blue', title: 'Blue', sku: 'BLUE', prices: [{ amount: 12, currency_code: 'eur' }] }] }] })); });
  const signedOut = () => localStorage.getItem('medusapos.session') === null;

  it.each(['stored', 'continue'] as const)('is disabled with the lock message during a held save and does nothing, then works once the save settles (%s)', async (settles) => {
    let save!: () => void;
    let fail!: (error: Error) => void;
    const record = vi.fn(() => new Promise<void>((resolve, reject) => { save = resolve; fail = reject; }));
    const isStored = vi.fn().mockResolvedValue(settles === 'continue');
    vi.mocked(useOutboxContext).mockReturnValue({ ...useOutboxContext(), record, isStored });
    await mountFramed();
    fireEvent.click(screen.getByTestId('product-tile-Shirt'));
    await payByCard();
    expect(signOutButton().getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(screen.getByTestId('user-sheet-close'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Complete sale' })); });
    expect(record).toHaveBeenCalledTimes(1);

    // Held: disabled in place, described by the tender's lock message, and a press signs nothing out.
    const signOut = signOutButton(SALE_SAVING);
    expect(signOut.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(signOut);
    expect(signedOut()).toBe(false);
    expect(router.replace).not.toHaveBeenCalled();
    expect(screen.queryByText('redirect:/login')).toBeNull();
    fireEvent.click(screen.getByTestId('user-sheet-close'));
    // The frame's Orders, Reports and Settings stay live: they push onto the stack, over the mounted sale.
    const rail = within(screen.getByTestId('nav-rail'));
    fireEvent.click(rail.getByRole('button', { name: 'Orders' }));
    fireEvent.click(rail.getByRole('button', { name: 'Reports' }));
    fireEvent.click(rail.getByRole('button', { name: 'Settings' }));
    expect(vi.mocked(router.push).mock.calls).toEqual([['/orders'], ['/reports'], ['/settings']]);

    if (settles === 'stored') {
      await act(async () => { save(); });
      expect(screen.getByRole('button', { name: 'Print receipt' })).toBeTruthy();
      expect(screen.queryByTestId('user-sheet')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'New sale' }));
    } else {
      await act(async () => { fail(new Error('Storage full')); });
      const continueButton = await screen.findByRole('button', { name: 'Continue' });
      expect(isStored).toHaveBeenCalledTimes(1);
      // Confirmed stored, but still locked until Continue is pressed.
      expect(signOutButton().getAttribute('aria-disabled')).toBe('true');
      fireEvent.click(signOutButton());
      expect(signedOut()).toBe(false);
      fireEvent.click(screen.getByTestId('user-sheet-close'));
      fireEvent.click(continueButton);
      expect(screen.getByText('Tap a product to start a sale')).toBeTruthy();
    }
    const unlocked = signOutButton();
    expect(unlocked.getAttribute('aria-disabled')).toBeNull();
    expect(screen.queryByText(SALE_SAVING)).toBeNull();
    fireEvent.click(unlocked);
    fireEvent.click(screen.getByTestId('switch-confirm-confirm'));
    expect(signedOut()).toBe(true);
    expect(screen.getByText('redirect:/login')).toBeTruthy();
  });

  // The central sale hold (ADR 0015): an automatic sign-out also waits for the receipt to clear.
  it('defers a replication 401 during a held save; the receipt shows and stays, and it signs out once after New sale', async () => {
    let save!: () => void;
    const record = vi.fn(() => new Promise<void>((resolve) => { save = resolve; }));
    vi.mocked(useOutboxContext).mockReturnValue({ ...useOutboxContext(), record });
    await mount();
    fireEvent.click(screen.getByTestId('product-tile-Shirt'));
    await payByCard();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Complete sale' })); });
    // Replication reports 401 twice while the save is held: nothing signs out or navigates.
    const onUnauthorized = vi.mocked(useReplicatedProducts).mock.lastCall![2];
    act(() => { onUnauthorized(); onUnauthorized(); });
    expect(signedOut()).toBe(false);
    expect(screen.queryByText('redirect:/login')).toBeNull();
    expect(screen.getByText('Signed out after this sale is saved')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Complete sale' })).toBeTruthy();

    await act(async () => { save(); });
    expect(screen.getByRole('button', { name: 'Print receipt' })).toBeTruthy();
    expect(signedOut()).toBe(false);
    // On the receipt, no earlier save: the wording says New sale, not "Signed out after this sale is saved" (#86 review, item 2).
    expect(screen.queryByText('Signed out after this sale is saved')).toBeNull();
    expect(screen.getByText('You\'ll be signed out when you start a new sale.')).toBeTruthy();
    expect(clearProductCache).not.toHaveBeenCalled();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'New sale' })); });
    expect(signedOut()).toBe(true);
    expect(screen.getByText('redirect:/login')).toBeTruthy();
    expect(screen.queryByText('You\'ll be signed out when you start a new sale.')).toBeNull();
    expect(clearProductCache).toHaveBeenCalledTimes(1);
  });

  it('stays disabled after a failed save that is not confirmed stored, until Retry stores it', async () => {
    const record = vi.fn().mockRejectedValueOnce(new Error('Storage full')).mockResolvedValue(undefined);
    vi.mocked(useOutboxContext).mockReturnValue({ ...useOutboxContext(), record, isStored: vi.fn().mockResolvedValue(false) });
    await mount();
    fireEvent.click(screen.getByTestId('product-tile-Shirt'));
    await payByCard();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Complete sale' })); });
    expect(screen.getByRole('alert').textContent).toBe('The sale could not be saved: Storage full');
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
    fireEvent.click(signOutButton());
    expect(signedOut()).toBe(false);
    expect(router.replace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('user-sheet-close'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Complete sale' })); });
    expect(screen.getByRole('button', { name: 'Print receipt' })).toBeTruthy();
    expect(screen.queryByTestId('user-sheet')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'New sale' }));
    fireEvent.click(signOutButton());
    fireEvent.click(screen.getByTestId('switch-confirm-confirm'));
    expect(signedOut()).toBe(true);
  });

  // TallyUI #161: while a save is in flight and unconfirmed, useSale re-asks isStored every 5 s (HUNG_SAVE_CHECK_MS),
  // through this app's own wiring (no hungSaveCheckMs). The outbox record doesn't settle until the test settles it: a
  // hung insert. The real SessionProvider and OutboxProvider hold sign-out on it, over a stand-in for TallyUI's
  // useOrderOutbox whose savesInFlight counts its record calls not yet settled, as TallyUI's does (#163).
  let settle: { resolve: () => void; reject: (error: Error) => void };
  let hungSession: ReturnType<typeof useSession>;
  let hungOutbox: ReturnType<typeof useOutboxContext>;
  function HungSessionProbe() { hungSession = useSession(); return null; }
  function HungOutboxProbe() { hungOutbox = useOutboxContext(); return null; }
  const hungTree = () => <SessionProvider><HungSessionProbe />
    <OutboxProvider><HungOutboxProbe /><ProductsScreen /><PortalHost /></OutboxProvider></SessionProvider>;
  let hungView: ReturnType<typeof render>;
  async function hungSale(isStored: (order: PosOrder) => Promise<boolean>) {
    const record = vi.fn((_order: PosOrder) => new Promise<void>((resolve, reject) => { settle = { resolve, reject }; }));
    vi.mocked(useOrderOutbox).mockImplementation(function useHungOutbox() {
      const [savesInFlight, setSavesInFlight] = useState(0);
      // Not null: these tests are about the hung-save mechanics, not the order-store-open gate (#86 review, item 5).
      return { orders: {} as never, state: { pending: 0, sending: false }, recent: [], savesInFlight, stuckCommandIds: [], isStored,
        flush: vi.fn().mockResolvedValue(undefined), requeue: vi.fn().mockResolvedValue(0),
        async record(order: PosOrder) {
          setSavesInFlight((count) => count + 1);
          try { await record(order); } finally { setSavesInFlight((count) => count - 1); }
        } };
    });
    vi.mocked(useOutboxContext).mockImplementation(realOutbox.useOutboxContext);
    saveSession(localStorage, { baseUrl: 'https://store.test', email: 'admin@store.test',
      token: `header.${btoa(JSON.stringify({ exp: Date.now() / 1000 + 86400 }))}.signature` });
    await act(async () => { hungView = render(hungTree()); });
    vi.useFakeTimers();
    fireEvent.click(screen.getByTestId('product-tile-Shirt'));
    await payByCard();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Complete sale' })); });
    expect(record).toHaveBeenCalledTimes(1);
    return record.mock.calls[0][0];
  }
  const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  const signOutDisabled = () => {
    const disabled = signOutButton().getAttribute('aria-disabled');
    fireEvent.click(screen.getByTestId('user-sheet-close'));
    return disabled;
  };
  /** Continue on a hung save confirmed stored at the first 5 s check: the new sale shows, Sign out waits for the old save. */
  async function continuePastHungSave() {
    await advance(5000);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText('Tap a product to start a sale')).toBeTruthy();
    const signOut = signOutButton(EARLIER_SALE_SAVING);
    expect(signOut.getAttribute('aria-disabled')).toBe('true');
    expect(screen.queryByText(SALE_SAVING)).toBeNull();
    fireEvent.click(signOut);
    expect(signedOut()).toBe(false);
    expect(screen.queryByText('redirect:/login')).toBeNull();
  }

  // Walks a 10 s hung save through several screens; on CI it runs near 4.6 s.
  it('offers Continue with no tap once a hung save is confirmed stored; Continue starts a new sale, and Sign out waits for that save', async () => {
    const isStored = vi.fn<(order: PosOrder) => Promise<boolean>>().mockResolvedValueOnce(false).mockResolvedValue(true);
    try {
      const saved = await hungSale(isStored);
      await advance(4999);
      expect(isStored).not.toHaveBeenCalled();
      expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
      expect(signOutDisabled()).toBe('true');
      // The first check, at 5 s, answers not stored yet; the next, at 10 s, confirms it.
      await advance(1);
      expect(isStored).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
      await advance(5000);
      expect(isStored).toHaveBeenCalledTimes(2);
      expect(isStored).toHaveBeenLastCalledWith(saved);
      const continueButton = screen.getByRole('button', { name: 'Continue' });
      // Confirmed stored, but still locked until Continue is pressed.
      expect(signOutDisabled()).toBe('true');
      fireEvent.click(signOutButton());
      expect(signedOut()).toBe(false);
      fireEvent.click(screen.getByTestId('user-sheet-close'));
      fireEvent.click(continueButton);
      expect(screen.getByText('Tap a product to start a sale')).toBeTruthy();
      // The #85 review: the abandoned save is still in flight, and RxDB's close would wait on it, so Sign out stays
      // locked, described as an earlier sale's. The next sale isn't held.
      expect(signOutButton(EARLIER_SALE_SAVING).getAttribute('aria-disabled')).toBe('true');
      expect(screen.queryByText(SALE_SAVING)).toBeNull();
      fireEvent.click(signOutButton());
      expect(signedOut()).toBe(false);
      fireEvent.click(screen.getByTestId('user-sheet-close'));
      fireEvent.click(screen.getByTestId('product-tile-Shirt'));
      expect(cartLineCells('Shirt')).toEqual(['1', 'Shirt', '€12.00', '€12.00']);
      // The poll has stopped.
      await advance(15000);
      expect(isStored).toHaveBeenCalledTimes(2);
      expect(signOutDisabled()).toBe('true');
      // Once the old save settles, Sign out is released and works.
      await act(async () => { settle.resolve(); });
      expect(signOutDisabled()).toBeNull();
      expect(screen.queryByText(EARLIER_SALE_SAVING)).toBeNull();
      fireEvent.click(signOutButton());
      fireEvent.click(screen.getByTestId('switch-confirm-confirm'));
      expect(signedOut()).toBe(true);
      expect(screen.getByText('redirect:/login')).toBeTruthy();
      cleanup();
    } finally { vi.useRealTimers(); }
  }, 15_000);

  it('keeps a deferred 401 pending past Continue while the abandoned hung save is in flight, then signs out once it settles', async () => {
    try {
      await hungSale(vi.fn().mockResolvedValue(true));
      act(() => { vi.mocked(useReplicatedProducts).mock.lastCall![2](); });
      expect(screen.getByText('Signed out after this sale is saved')).toBeTruthy();
      await continuePastHungSave();
      expect(clearProductCache).not.toHaveBeenCalled();
      await advance(15000);
      expect(signedOut()).toBe(false);
      await act(async () => { settle.resolve(); });
      expect(signedOut()).toBe(true);
      expect(screen.getByText('redirect:/login')).toBeTruthy();
      expect(clearProductCache).toHaveBeenCalledTimes(1);
      cleanup();
    } finally { vi.useRealTimers(); }
  });

  it('releases Sign out when the abandoned hung save rejects late, after Continue', async () => {
    try {
      await hungSale(vi.fn().mockResolvedValue(true));
      await continuePastHungSave();
      await act(async () => { settle.reject(new Error('Storage full')); });
      // The new sale carries on, with no error from the old one.
      expect(screen.getByText('Tap a product to start a sale')).toBeTruthy();
      expect(screen.queryByText(/could not be saved/)).toBeNull();
      expect(signOutDisabled()).toBeNull();
      fireEvent.click(signOutButton());
      fireEvent.click(screen.getByTestId('switch-confirm-confirm'));
      expect(signedOut()).toBe(true);
      cleanup();
    } finally { vi.useRealTimers(); }
  });

  it('offers no Continue while a hung save is never confirmed stored, and Sign out stays locked', async () => {
    const isStored = vi.fn<(order: PosOrder) => Promise<boolean>>().mockResolvedValue(false);
    try {
      await hungSale(isStored);
      await advance(15000);
      expect(isStored).toHaveBeenCalledTimes(3);
      expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Complete sale' })).toBeTruthy();
      expect(signOutButton(SALE_SAVING).getAttribute('aria-disabled')).toBe('true');
      fireEvent.click(signOutButton());
      expect(signedOut()).toBe(false);
      expect(screen.queryByText('redirect:/login')).toBeNull();
      cleanup();
    } finally { vi.useRealTimers(); }
  });

  // (d) The #85 re-review's gap: store settings that unmount the sale screen after Continue release its sale hold, but
  // the saves hold is OutboxProvider's, so an automatic sign-out still waits for the abandoned save.
  it('keeps an automatic sign-out waiting on the abandoned hung save after store settings unmount the sale, then signs out once it settles', async () => {
    try {
      await hungSale(vi.fn().mockResolvedValue(true));
      await continuePastHungSave();
      vi.mocked(useStoreSettings).mockReturnValue({ state: 'unsupported' });
      await act(async () => { hungView.rerender(hungTree()); });
      expect(screen.getByText('This backend can\'t supply store settings')).toBeTruthy();
      expect(screen.queryByTestId('user-menu')).toBeNull();
      // (g) #86 review, item 1: the earlier-sale note shows above the settings screen too, not only the sale screen.
      expect(screen.getByText(EARLIER_SALE_SAVING)).toBeTruthy();
      act(() => { hungSession.reportUnauthorized(); });
      expect(hungOutbox.savesInFlight).toBe(1);
      expect(hungSession.signOutDeferred).toBe(true);
      expect(signedOut()).toBe(false);
      expect(screen.getByText('An earlier sale is still being saved. You\'ll be signed out once it\'s saved.')).toBeTruthy();
      await advance(15000);
      expect(hungOutbox.savesInFlight).toBe(1);
      expect(signedOut()).toBe(false);
      expect(screen.queryByText('redirect:/login')).toBeNull();
      expect(clearProductCache).not.toHaveBeenCalled();

      await act(async () => { settle.resolve(); });
      expect(hungOutbox.savesInFlight).toBe(0);
      expect(signedOut()).toBe(true);
      expect(screen.getByText('redirect:/login')).toBeTruthy();
      expect(clearProductCache).toHaveBeenCalledTimes(1);
      cleanup();
    } finally { vi.useRealTimers(); }
  });

  // (e) Sign out's lock, shown: the visible note under the header, not the hidden description (#sign-out-locked).
  it.each(['without', 'with'] as const)('shows why Sign out is locked after Continue on a hung save (%s a deferred 401) until the save settles', async (deferred) => {
    const DEFERRED_NOTE = 'An earlier sale is still being saved. You\'ll be signed out once it\'s saved.';
    const visible = (text: string) => screen.queryByText(text, { ignore: '#sign-out-locked, script, style' });
    try {
      await hungSale(vi.fn().mockResolvedValue(true));
      expect(visible(EARLIER_SALE_SAVING)).toBeNull();
      await continuePastHungSave();
      expect(visible(EARLIER_SALE_SAVING)!.closest('[data-print="hide"]')).toBeTruthy();
      expect(visible(DEFERRED_NOTE)).toBeNull();
      expect(screen.queryByText('Signed out after this sale is saved')).toBeNull();
      if (deferred === 'with') {
        act(() => { hungSession.reportUnauthorized(); });
        expect(visible(EARLIER_SALE_SAVING)).toBeNull();
        expect(visible(DEFERRED_NOTE)).toBeTruthy();
        expect(screen.queryByText('Signed out after this sale is saved')).toBeNull();
      }
      // The accessible description is unchanged.
      expect(signOutButton(EARLIER_SALE_SAVING)).toBeTruthy();

      await act(async () => { settle.resolve(); });
      expect(visible(EARLIER_SALE_SAVING)).toBeNull();
      expect(visible(DEFERRED_NOTE)).toBeNull();
      expect(signedOut()).toBe(deferred === 'with');
      if (deferred === 'without') expect(signOutDisabled()).toBeNull();
      cleanup();
    } finally { vi.useRealTimers(); }
  });
});

// Settings → Scanner's minChars is the Products search's minCodeLength (ADR 0016, TallyUI #148).
describe('ProductsScreen search minCodeLength', () => {
  beforeEach(() => { vi.mocked(useReplicatedProducts).mockReturnValue(replicated({ products: [{ id: 'shirt', title: 'Shirt',
    status: 'published', variants: [{ id: 'blue', title: 'Blue', sku: 'AB123', prices: [{ amount: 12, currency_code: 'eur' }] }] }] })); });

  it.each([[6, false], [3, true]])('with minChars %i, Enter on the 5-character code "AB123" adds the product: %s', async (minChars, adds) => {
    saveScannerSettings(localStorage, 'https://store.test', { ...DEFAULT_SCANNER_SETTINGS, avgKeyMs: 100, minChars });
    await mount();
    const search = screen.getByRole('searchbox') as HTMLInputElement;
    fireEvent.change(search, { target: { value: 'AB123' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    if (adds) {
      expect(cartLineCells('Shirt')).toEqual(['1', 'Shirt', '€12.00', '€12.00']);
      expect(search.value).toBe('');
    } else {
      // No code lookup: the text stays a search, still showing its match, and the cart stays empty.
      expect(screen.queryByRole('button', { name: 'Edit quantity of Shirt' })).toBeNull();
      expect(screen.getByText('Tap a product to start a sale')).toBeTruthy();
      expect(search.value).toBe('AB123');
      expect(screen.getByTestId('product-tile-Shirt')).toBeTruthy();
    }
  });
});

// The #82 review: every sign-out path honours SessionProvider's sale hold, through the real provider and screen.
describe('ProductsScreen: every sign-out waits for a saving sale', () => {
  const NOTE = 'Signed out after this sale is saved';
  const jwt = (exp: number) => `header.${btoa(JSON.stringify({ exp }))}.signature`;
  const inADay = () => jwt(Math.floor(Date.now() / 1000) + 86400);
  let context: ReturnType<typeof useSession>;
  function SessionProbe() { context = useSession(); return null; }
  let reject!: (error: Error) => void;
  const held = () => new Promise<never>((_resolve, fail) => { reject = fail; });
  const signedIn = () => localStorage.getItem('medusapos.session') !== null;
  const button = (name: string) => screen.getByRole('button', { name });
  beforeEach(() => { vi.mocked(useReplicatedProducts).mockReturnValue(replicated({ products: [{ id: 'shirt', title: 'Shirt',
    status: 'published', variants: [{ id: 'blue', title: 'Blue', sku: 'BLUE', prices: [{ amount: 12, currency_code: 'eur' }] }] }] })); });
  afterEach(() => { vi.mocked(refreshSession).mockReset(); vi.mocked(login).mockReset(); });

  it('builds a new connector for each store session and keeps it for the whole session', async () => {
    saveSession(localStorage, { baseUrl: 'https://store.test', email: 'admin@store.test', token: inADay() });
    let view!: ReturnType<typeof render>;
    await act(async () => { view = render(<SessionProvider><SessionProbe /><ProductsScreen /></SessionProvider>); });
    const a = vi.mocked(useReplicatedProducts).mock.lastCall![0];

    await act(async () => { view.rerender(<SessionProvider><SessionProbe /><ProductsScreen /></SessionProvider>); });
    expect(vi.mocked(useReplicatedProducts).mock.lastCall![0]).toBe(a);
    const renewed = jwt(Math.floor(Date.now() / 1000) + 2 * 86400);
    vi.mocked(login).mockResolvedValue({ baseUrl: 'https://store.test', email: 'admin@store.test', token: renewed });
    await act(async () => { await context.signIn('https://store.test', 'admin@store.test', 'password'); });
    expect(context.session?.token).toBe(renewed);
    expect(vi.mocked(useReplicatedProducts).mock.lastCall![0]).toBe(a);

    act(() => { context.signOut(); });
    expect(screen.getByText('redirect:/login')).toBeTruthy();
    await act(async () => { await context.signIn('https://store.test', 'admin@store.test', 'password'); });
    const b = vi.mocked(useReplicatedProducts).mock.lastCall![0];
    expect(b).not.toBe(a);
  });

  async function mountTill(token = inADay()) {
    saveSession(localStorage, { baseUrl: 'https://store.test', email: 'admin@store.test', token });
    await act(async () => { render(<SessionProvider><SessionProbe /><ProductsScreen /><PortalHost /></SessionProvider>); });
  }
  it('resumes a stopped product pull after the session is renewed in place, never on mount', async () => {
    const resumePull = vi.fn();
    vi.mocked(useReplicatedProducts).mockReturnValue(replicated({
      pullNotice: { code: 'unauthorized', since: 0, fixedBy: 'till' }, resumePull,
    }));
    await mountTill();
    expect(resumePull).not.toHaveBeenCalled();
    const renewed = jwt(Math.floor(Date.now() / 1000) + 2 * 86400);
    vi.mocked(login).mockResolvedValue({ baseUrl: 'https://store.test', email: 'admin@store.test', token: renewed });
    await act(async () => { await context.signIn('https://store.test', 'admin@store.test', 'password'); });
    expect(context.session?.token).toBe(renewed);
    expect(resumePull).toHaveBeenCalledTimes(1);
  });

  it('a token renewed in place keeps the same sync context and onUnauthorized, so catalogue sync never restarts; requests read the new token', async () => {
    await mountTill();
    const [, syncContext, onUnauthorized] = vi.mocked(useReplicatedProducts).mock.calls[0];
    const renewed = jwt(Math.floor(Date.now() / 1000) + 2 * 86400);
    vi.mocked(login).mockResolvedValue({ baseUrl: 'https://store.test', email: 'admin@store.test', token: renewed });
    await act(async () => { await context.signIn('https://store.test', 'admin@store.test', 'password'); });
    const [, latestContext, latestOnUnauthorized] = vi.mocked(useReplicatedProducts).mock.lastCall!;
    expect(latestContext).toBe(syncContext);
    expect(latestOnUnauthorized).toBe(onUnauthorized);
    expect(syncContext.headers.Authorization).toBe('Bearer ' + renewed);
  });

  /** Tenders the shirt by card; the first save fails and isn't stored, the retry stores it. */
  async function failedSave(token?: string) {
    const record = vi.fn().mockRejectedValueOnce(new Error('Storage full')).mockResolvedValue(undefined);
    vi.mocked(useOutboxContext).mockReturnValue({ ...useOutboxContext(), record, isStored: vi.fn().mockResolvedValue(false) });
    await mountTill(token);
    fireEvent.click(screen.getByTestId('product-tile-Shirt'));
    await payByCard();
    await act(async () => { fireEvent.click(button('Complete sale')); });
    expect(screen.getByRole('alert').textContent).toBe('The sale could not be saved: Storage full');
  }

  const paths: Record<string, { token?: () => string; arm?: () => void; request: () => void }> = {
    // Disabled while saving (a press does nothing); the request it would make is the context's signOut.
    'the Sign out button': { request: () => { fireEvent.click(signOutButton()); fireEvent.click(screen.getByTestId('user-sheet-close')); context.signOut(); } },
    'a product replication 401': { request: () => vi.mocked(useReplicatedProducts).mock.lastCall![2]() },
    'the capabilities check': {
      arm: () => { capabilities.mockImplementation(held); },
      request: () => reject(new SignInError('invalid_credentials', 'Token expired', 401)),
    },
    'the store-settings fetch': {
      arm: () => { vi.mocked(fetchStoreSettings).mockImplementation(held); },
      request: () => reject(new StoreSettingsError('unauthorized', 'Please sign in again.')),
    },
    'a refresh refused with invalid_credentials': {
      token: () => jwt(Math.floor(Date.now() / 1000) + 3600),
      arm: () => { vi.mocked(refreshSession).mockImplementation(held); },
      request: () => reject(new LoginError('invalid_credentials', 'Token expired')),
    },
  };

  it.each(Object.keys(paths))('%s: deferred during a failed save, then signs out once after Retry and New sale', async (name) => {
    const path = paths[name];
    path.arm?.();
    await failedSave(path.token?.());
    if (name === 'the Sign out button') fireEvent.click(screen.getByTestId('user-menu'));
    await act(async () => { path.request(); });
    // The sale stays mounted on its tender, and the session stays.
    expect(button('Complete sale')).toBeTruthy();
    expect(signedIn()).toBe(true);
    expect(screen.queryByText('redirect:/login')).toBeNull();
    expect(screen.getByText(NOTE)).toBeTruthy();

    await act(async () => { fireEvent.click(button('Complete sale')); });
    expect(button('Print receipt')).toBeTruthy();
    expect(signedIn()).toBe(true);
    expect(clearProductCache).not.toHaveBeenCalled();

    await act(async () => { fireEvent.click(button('New sale')); });
    expect(signedIn()).toBe(false);
    expect(screen.getByText('redirect:/login')).toBeTruthy();
    expect(clearProductCache).toHaveBeenCalledTimes(1);
  });

  // The #82 re-review: the sale screen can unmount for other reasons (LiveTabGate's park, a blocking storage prompt).
  // Its release must not run the pending sign-out then; the next mounted sale screen's release does.
  it('keeps a deferred sign-out pending when the sale screen unmounts mid-save, and runs it once a sale screen remounts', async () => {
    const record = vi.fn(() => new Promise<void>(() => {}));
    vi.mocked(useOutboxContext).mockReturnValue({ ...useOutboxContext(), record });
    const Root = ({ sale }: { sale: boolean }) => <SessionProvider><SessionProbe />{sale ? <ProductsScreen /> : null}</SessionProvider>;
    saveSession(localStorage, { baseUrl: 'https://store.test', email: 'admin@store.test', token: inADay() });
    let view!: ReturnType<typeof render>;
    await act(async () => { view = render(<Root sale />); });
    fireEvent.click(screen.getByTestId('product-tile-Shirt'));
    await payByCard();
    await act(async () => { fireEvent.click(button('Complete sale')); });
    act(() => { vi.mocked(useReplicatedProducts).mock.lastCall![2](); });
    expect(screen.getByText(NOTE)).toBeTruthy();

    await act(async () => { view.rerender(<Root sale={false} />); });
    expect(signedIn()).toBe(true);
    expect(clearProductCache).not.toHaveBeenCalled();
    expect(context.signOutDeferred).toBe(true);

    await act(async () => { view.rerender(<Root sale />); });
    expect(signedIn()).toBe(false);
    expect(screen.getByText('redirect:/login')).toBeTruthy();
    expect(clearProductCache).toHaveBeenCalledTimes(1);
  });

  it('drops a request deferred under one token once the session is renewed to another, and never signs out', async () => {
    const renewed = jwt(Math.floor(Date.now() / 1000) + 2 * 86400);
    vi.mocked(login).mockResolvedValue({ baseUrl: 'https://store.test', email: 'admin@store.test', token: renewed });
    await failedSave();
    act(() => { vi.mocked(useReplicatedProducts).mock.lastCall![2](); });
    expect(screen.getByText(NOTE)).toBeTruthy();
    // SignInAgain's renewal: the pending request goes, and so does the note.
    await act(async () => { await context.signIn('https://store.test', 'admin@store.test', 'password'); });
    expect(context.session?.token).toBe(renewed);
    expect(screen.queryByText(NOTE)).toBeNull();

    await act(async () => { fireEvent.click(button('Complete sale')); });
    await act(async () => { fireEvent.click(button('New sale')); });
    expect(signedIn()).toBe(true);
    expect(screen.queryByText('redirect:/login')).toBeNull();
    expect(clearProductCache).not.toHaveBeenCalled();
    expect(screen.getByText('Tap a product to start a sale')).toBeTruthy();
  });
});

// #86 review, item 2: the earlier-sale note's exact wording, by savesInFlight, sale.saving, signOutDeferred and the receipt stage.
describe('ProductsScreen earlier-sale note wording', () => {
  let context: ReturnType<typeof useSession>;
  function SessionProbe() { context = useSession(); return null; }
  // The hidden Sign out description shares EARLIER_SALE_SAVING's exact text while signOutLocked, so plain-text
  // checks must ignore it (as the hung-save tests above do), or getByText matches both nodes.
  const visible = (text: string) => screen.getByText(text, { ignore: '#sign-out-locked, script, style' });
  beforeEach(() => { vi.mocked(useReplicatedProducts).mockReturnValue(replicated({ products: [{ id: 'shirt', title: 'Shirt',
    status: 'published', variants: [{ id: 'blue', title: 'Blue', sku: 'BLUE', prices: [{ amount: 12, currency_code: 'eur' }] }] }] })); });

  async function arrange(savesInFlight: number, record: (order: PosOrder) => Promise<void>) {
    vi.mocked(useOutboxContext).mockReturnValue({ ...useOutboxContext(), savesInFlight, record });
    saveSession(localStorage, { baseUrl: 'https://store.test', email: 'admin@store.test',
      token: `header.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86400 }))}.signature` });
    await act(async () => { render(<SessionProvider><SessionProbe /><ProductsScreen /></SessionProvider>); });
  }
  async function pay(savesInFlight: number, resolves: boolean) {
    const record = vi.fn<(order: PosOrder) => Promise<void>>();
    await arrange(savesInFlight, resolves ? record.mockResolvedValue(undefined) : record.mockImplementation(() => new Promise(() => {})));
    fireEvent.click(screen.getByTestId('product-tile-Shirt'));
    await payByCard();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Complete sale' })); });
  }

  it('shows only the plain note for an earlier save in flight, not deferred', async () => {
    await arrange(1, vi.fn<(order: PosOrder) => Promise<void>>());
    expect(visible(EARLIER_SALE_SAVING)).toBeTruthy();
  });
  it('adds "once it\'s saved" for an earlier save in flight, deferred, off the receipt', async () => {
    await arrange(1, vi.fn<(order: PosOrder) => Promise<void>>());
    act(() => context.setSavesHold(true));
    act(() => context.signOut());
    expect(visible(`${EARLIER_SALE_SAVING} You'll be signed out once it's saved.`)).toBeTruthy();
  });
  it('adds "and you start a new sale" for an earlier save in flight, deferred, on the receipt', async () => {
    await pay(1, true);
    expect(screen.getByRole('button', { name: 'Print receipt' })).toBeTruthy();
    act(() => context.reportUnauthorized());
    expect(visible(`${EARLIER_SALE_SAVING} You'll be signed out once it's saved and you start a new sale.`)).toBeTruthy();
  });
  it('keeps "Signed out after this sale is saved" while this sale itself is saving, with no earlier save', async () => {
    await pay(0, false);
    act(() => context.reportUnauthorized());
    expect(visible('Signed out after this sale is saved')).toBeTruthy();
  });
  it('says the sign-out waits for a new sale on the receipt, with no earlier save', async () => {
    await pay(0, true);
    expect(screen.getByRole('button', { name: 'Print receipt' })).toBeTruthy();
    act(() => context.reportUnauthorized());
    expect(visible('You\'ll be signed out when you start a new sale.')).toBeTruthy();
  });
  it('shows no note with nothing pending', async () => {
    await arrange(0, vi.fn<(order: PosOrder) => Promise<void>>());
    expect(screen.queryByText(/signed out|being saved/i, { ignore: '#sign-out-locked, script, style' })).toBeNull();
  });
});

// #86 review, item 3: the Reload hint, appended to the earlier-sale note once storage reports a stall.
describe('ProductsScreen earlier-sale reload hint', () => {
  const visible = (text: string) => screen.getByText(text, { ignore: '#sign-out-locked, script, style' });
  function drive(status: 'ok' | 'stalled') {
    return watchStorageHealth(new BehaviorSubject<StorageHealthReading>({ status, stalledWrites: status === 'stalled' ? 1 : 0 }));
  }
  it('appends the reload hint once storage reports stalled', async () => {
    const unregister = drive('stalled');
    try {
      vi.mocked(useOutboxContext).mockReturnValue({ ...useOutboxContext(), savesInFlight: 1 });
      await mount();
      expect(visible(`${EARLIER_SALE_SAVING} That sale is already stored; reload if this doesn't clear.`)).toBeTruthy();
    } finally { unregister(); }
  });
  it('shows no hint while storage is ok', async () => {
    const unregister = drive('ok');
    try {
      vi.mocked(useOutboxContext).mockReturnValue({ ...useOutboxContext(), savesInFlight: 1 });
      await mount();
      expect(visible(EARLIER_SALE_SAVING)).toBeTruthy();
      expect(screen.queryByText(/That sale is already stored/)).toBeNull();
    } finally { unregister(); }
  });
});

// #86 review, item 5: paying waits for the order store to open.
describe('ProductsScreen tender gated on the order store opening', () => {
  beforeEach(() => { vi.mocked(useReplicatedProducts).mockReturnValue(replicated({ products: [{ id: 'shirt', title: 'Shirt',
    status: 'published', variants: [{ id: 'blue', title: 'Blue', sku: 'BLUE', prices: [{ amount: 12, currency_code: 'eur' }] }] }] })); });
  it('says it couldn\'t check the register, and logs why, when the check fails for another reason', async () => {
    const fixture = openRegisterFixture();
    vi.mocked(fixture.register.requireSaleSession).mockRejectedValue(new Error('storage went away'));
    vi.mocked(useRegister).mockReturnValue(fixture);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await mount();
      fireEvent.click(screen.getByTestId('product-tile-Shirt'));
      await checkout();
      expect(screen.getByRole('alert').textContent).toBe("Couldn't check the register. Try again.");
      expect(screen.queryByRole('button', { name: 'Complete sale' })).toBeNull();
      expect(warn).toHaveBeenCalledWith('Could not check the register at tender start:', expect.objectContaining({ message: 'storage went away' }));
    } finally { warn.mockRestore(); }
  });

  // While orders is null the register isn't enabled either (its collections are in the same store, ADR 0017).
  it('refuses to start a tender while orders is null, saying so, then tenders once it opens', async () => {
    vi.mocked(useOutboxContext).mockReturnValue({ ...useOutboxContext(), orders: null });
    vi.mocked(useRegister).mockReturnValue(openRegisterFixture({ enabled: false }));
    const view = await mount();
    fireEvent.click(screen.getByTestId('product-tile-Shirt'));
    await checkout();
    expect(screen.getByRole('alert').textContent).toBe('Getting ready to save sales…');
    expect(screen.queryByRole('button', { name: 'Complete sale' })).toBeNull();
    vi.mocked(useOutboxContext).mockReturnValue({ ...useOutboxContext(), orders: {} as never });
    vi.mocked(useRegister).mockReturnValue(openRegisterFixture());
    await act(async () => { view.rerender(<SessionProvider><ProductsScreen /></SessionProvider>); });
    await checkout();
    expect(screen.getByRole('button', { name: 'Complete sale' })).toBeTruthy();
  });
});

// Settings > Scanner's direct connection: a device scan reaches the sale through the app's ScanHubProvider, on the
// wide window too (the wedge listener is phone-cart-only), with no search-box focus.
describe('ProductsScreen device scans', () => {
  beforeEach(() => { vi.mocked(useReplicatedProducts).mockReturnValue(replicated({ products: [{ id: 'shirt', title: 'Shirt',
    status: 'published', variants: [{ id: 'blue', title: 'Blue', sku: 'AB123', prices: [{ amount: 12, currency_code: 'eur' }] }] }] })); });

  async function mountWithHub() {
    const { ScanHubProvider, useScanHub } = await import('@tallyui/pos');
    const hub: { current?: ReturnType<typeof useScanHub> } = {};
    function HubProbe() { hub.current = useScanHub(); return null; }
    saveSession(localStorage, { baseUrl: 'https://store.test', email: 'admin@store.test',
      token: `header.${btoa(JSON.stringify({ exp: Date.now() / 1000 + 86400 }))}.signature` });
    await act(async () => {
      render(<SessionProvider><ScanHubProvider profiles={{ read: async () => [], save: async () => {} }}
        settings={{ prefix: '', suffix: '', minChars: 3 }}><HubProbe /><ProductsScreen /></ScanHubProvider><PortalHost /></SessionProvider>);
    });
    return (code: string) => act(() => { hub.current!.emit({ code, source: { kind: 'hid-pos' }, timestamp: Date.now() }); });
  }

  it('adds the product a device scan names, on the wide window', async () => {
    const scan = await mountWithHub();
    // The search box takes focus on mount; blurred, so the code can only arrive through the hub.
    act(() => { screen.getByRole('searchbox').blur(); });
    expect(document.activeElement).not.toBe(screen.getByRole('searchbox'));
    scan('AB123');
    expect(cartLineCells('Shirt')).toEqual(['1', 'Shirt', '€12.00', '€12.00']);
  });

  it('says no product matches an unknown code, on the wide window', async () => {
    const scan = await mountWithHub();
    scan('NOPE1');
    expect(screen.getByText('No product matches "NOPE1"')).toBeTruthy();
  });
});

// Row 14a (#443): an area's avatar opens the Sale's user sheet through the frame's account. The probe stands in for an
// area's avatar (AreaAccountButton), pressing the account's open() under the real AppFrame.
describe('ProductsScreen user sheet opened from an area', () => {
  beforeEach(() => { vi.mocked(useReplicatedProducts).mockReturnValue(replicated({ products: [{ id: 'shirt', title: 'Shirt',
    status: 'published', variants: [{ id: 'blue', title: 'Blue', sku: 'BLUE', prices: [{ amount: 12, currency_code: 'eur' }] }] }] })); });
  const tab = (name: RegExp) => screen.getByRole('tab', { name });
  const switchRegister = () => act(async () => { fireEvent.click(screen.getByTestId('user-sheet-register-switch')); });

  async function mountWithAreaAvatar() {
    const { useFrameAccount } = await import('../components/app-frame');
    function AreaAvatarProbe() {
      const account = useFrameAccount();
      return <button type="button" data-testid="area-avatar-probe" onClick={() => account?.open()} />;
    }
    saveSession(localStorage, { baseUrl: 'https://store.test', email: 'admin@store.test',
      token: `header.${btoa(JSON.stringify({ exp: Date.now() / 1000 + 86400 }))}.signature` });
    await act(async () => {
      render(<SessionProvider><AppFrame signedIn><ProductsScreen /><AreaAvatarProbe /></AppFrame><PortalHost /></SessionProvider>);
    });
    return () => act(() => { fireEvent.click(screen.getByTestId('area-avatar-probe')); });
  }

  it('shows the sheet over the sale\'s receipt when an area opens it', async () => {
    const openFromArea = await mountWithAreaAvatar();
    fireEvent.click(screen.getByTestId('product-tile-Shirt'));
    await payByCard();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Complete sale' })); });
    expect(screen.getByRole('button', { name: 'Print receipt' })).toBeTruthy();
    expect(screen.queryByTestId('user-sheet')).toBeNull();
    openFromArea();
    expect(screen.getByTestId('user-sheet')).toBeTruthy();
  });

  // Switch register is disabled while a session exists, so the till is bound with no session (a finished close).
  // At 360 wide the gate opening is visible: openGate selects the Cart tab.
  it('from an area, Switch register goes back to the sale before the gate; from the sale\'s avatar it does not', async () => {
    const fixture = openRegisterFixture();
    vi.mocked(useRegister).mockReturnValue({ ...fixture, register: { ...fixture.register, session: null } });
    setWindowWidth(360);
    const openFromArea = await mountWithAreaAvatar();
    fireEvent.click(tab(/^Products/));
    expect(tab(/^Cart/).getAttribute('aria-selected')).toBe('false');
    openFromArea();
    await switchRegister();
    expect(fixture.unbind).toHaveBeenCalledTimes(1);
    expect(router.dismissTo).toHaveBeenCalledExactlyOnceWith('/');
    expect(tab(/^Cart/).getAttribute('aria-selected')).toBe('true');

    vi.mocked(router.dismissTo).mockClear();
    fireEvent.click(tab(/^Products/));
    fireEvent.click(screen.getByTestId('user-menu'));
    await switchRegister();
    expect(fixture.unbind).toHaveBeenCalledTimes(2);
    expect(router.dismissTo).not.toHaveBeenCalled();
    expect(tab(/^Cart/).getAttribute('aria-selected')).toBe('true');
  });
});
