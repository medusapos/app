// @vitest-environment jsdom
// v2's Cart Settings "Automatically show receipt after checkout" (row 05d.3), with Settings › Printing's auto-print.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PortalHost } from '@tallyui/primitives';
import type { PosOrder } from '@tallyui/pos';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ProductsScreen from '../app/index';
import { DEFAULT_CART_SETTINGS, loadCartSettings, saveCartSettings } from '../lib/cart-settings';
import { openOrderStore } from '../lib/order-store';
import { useOutboxContext } from '../lib/outbox-context';
import { savePrintingSettings } from '../lib/printing-settings';
import { useRegister } from '../lib/register-context';
import { useSession } from '../lib/session-context';
import { sessionFixture } from './session-fixture';
import { fetchStoreSettings } from '../lib/store-settings';
import { useReplicatedProducts } from '../lib/use-replicated-products';
import { capabilities, storeSettings } from './pos-connector-mock';
import { openRegisterFixture } from './register-fixture';
import { setWindowWidth } from './window-width';
import { takeLeg } from './tender-pane';

vi.mock('../lib/pos-connector', async (original) => (await import('./pos-connector-mock')).mockPosConnector(original));
vi.mock('expo-router', () => ({ Redirect: () => null, Stack: { Screen: () => null } }));
vi.mock('expo-localization', () => ({ getCalendars: () => [{ uses24hourClock: null }] }));
vi.mock('../lib/session-context', () => ({ useSession: vi.fn() }));
vi.mock('../lib/outbox-context', () => ({ useOutboxContext: vi.fn() }));
vi.mock('../lib/use-replicated-products', () => ({ useReplicatedProducts: vi.fn() }));
vi.mock('../lib/register-context', async (original) => ({
  ...await original<typeof import('../lib/register-context')>(), useRegister: vi.fn(),
}));
vi.mock('../lib/store-settings', async (original) => ({
  ...await original<typeof import('../lib/store-settings')>(), fetchStoreSettings: vi.fn(),
}));

let store: Awaited<ReturnType<typeof openOrderStore>>;
let baseUrl: string;
const record = vi.fn(async (_order: PosOrder) => {});
const newSaleButton = () => screen.queryByRole('button', { name: 'New sale' });
beforeEach(async () => {
  setWindowWidth(1280);
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  });
  baseUrl = `https://auto-show-${crypto.randomUUID()}.test`;
  const session = { baseUrl, email: 'admin@store.test', token: 'jwt',
    capabilities: { orderCreate: 4, taxRounding: { granularity: 'per_order' as const, mode: 'half_away_from_zero' as const } } };
  vi.mocked(useSession).mockReturnValue(sessionFixture(session));
  capabilities.mockResolvedValue(session.capabilities);
  storeSettings.mockResolvedValue({ currency: 'EUR', pricesIncludeTax: false, taxRatesPpm: { default: 250000 },
    pricingContext: { region_id: 'reg_eu', currency_code: 'eur', publishable_key: 'pk_1' } });
  vi.mocked(fetchStoreSettings).mockResolvedValue({ storeName: 'Test shop', currency: 'EUR',
    location: { id: 'loc', name: 'Main', countryCode: 'dk' } });
  vi.mocked(useRegister).mockReturnValue(openRegisterFixture());
  vi.mocked(useReplicatedProducts).mockReturnValue({ products: [{ id: 'shirt', title: 'Shirt', status: 'published',
    variants: [{ id: 'blue', title: 'Blue', sku: 'BLUE', prices: [{ amount: 19.2, currency_code: 'eur' }] }] }],
    state: 'synced', error: null, lastSyncedAt: null, stockOverlay: undefined, lastStockCheckAt: null,
    reconcileStock: vi.fn(async () => {}), pullNotice: undefined, resumePull: vi.fn(), unlisted: undefined });
  store = await openOrderStore(session.baseUrl);
  record.mockReset().mockResolvedValue(undefined);
  vi.mocked(useOutboxContext).mockReturnValue({ orders: store.orders, record, state: { pending: 0, sending: false },
    recent: [], savesInFlight: 0, stuckCommandIds: [], flush: vi.fn(), requeue: vi.fn(), isStored: vi.fn(async () => true) });
});
afterEach(async () => {
  cleanup();
  await store.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

async function mount() {
  await act(async () => { render(<><ProductsScreen /><PortalHost /></>); });
  await screen.findByTestId('product-tile-Shirt');
}
/** Sells the Shirt for cash: Checkout, one cash leg for the full total, Complete. */
async function sellShirt() {
  fireEvent.click(screen.getByTestId('product-tile-Shirt'));
  await act(async () => { fireEvent.click(screen.getByTestId('cart-checkout')); });
  takeLeg('cash', '24.00');
  await act(async () => { fireEvent.click(screen.getByTestId('tender-complete')); });
}
/** The till is back on a new, empty sale: the product grid and the empty cart, with no Shirt line. */
async function expectNextSale() {
  await waitFor(() => {
    expect(screen.getByTestId('product-tile-Shirt')).toBeTruthy();
    expect(screen.getByTestId('cart-empty')).toBeTruthy();
  });
  expect(newSaleButton()).toBeNull();
  expect(screen.queryByRole('button', { name: 'Edit quantity of Shirt' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Remove Shirt' })).toBeNull();
}

// The keypad tender pane's steps exceed the 5 s default on CI runners.
it('shows the receipt after checkout by default', async () => {
  await mount();
  await sellShirt();
  await screen.findByRole('button', { name: 'New sale' });
  expect(record).toHaveBeenCalledOnce();
}, 15000);

it('turns the switch off in Cart Settings, saves it, and then skips the receipt', async () => {
  await mount();
  fireEvent.click(screen.getByTestId('cart-settings-button'));
  const toggle = screen.getByTestId('cart-settings-auto-show-receipt');
  expect(toggle.getAttribute('aria-checked')).toBe('true');
  fireEvent.click(toggle);
  expect(screen.getByTestId('cart-settings-auto-show-receipt').getAttribute('aria-checked')).toBe('false');
  fireEvent.click(screen.getByTestId('cart-settings-close'));
  expect(loadCartSettings(localStorage, baseUrl).autoShowReceipt).toBe(false);
  await sellShirt();
  await expectNextSale();
  expect(record).toHaveBeenCalledOnce();
}, 15000);

it('with auto-show off and auto-print on, prints once from the receipt and then starts the next sale', async () => {
  saveCartSettings(localStorage, baseUrl, { ...DEFAULT_CART_SETTINGS, autoShowReceipt: false });
  savePrintingSettings(localStorage, baseUrl, { autoPrintReceipt: true });
  const shownWhilePrinting: boolean[] = [];
  const print = vi.spyOn(window, 'print').mockImplementation(() => { shownWhilePrinting.push(newSaleButton() !== null); });
  await mount();
  await sellShirt();
  await expectNextSale();
  expect(print).toHaveBeenCalledTimes(1);
  expect(shownWhilePrinting).toEqual([true]);
  expect(record).toHaveBeenCalledOnce();
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
  expect(print).toHaveBeenCalledTimes(1);
}, 15000);

it('with auto-show off and auto-print off, never prints', async () => {
  saveCartSettings(localStorage, baseUrl, { ...DEFAULT_CART_SETTINGS, autoShowReceipt: false });
  const print = vi.spyOn(window, 'print').mockImplementation(() => {});
  await mount();
  await sellShirt();
  await expectNextSale();
  expect(print).not.toHaveBeenCalled();
}, 15000);
