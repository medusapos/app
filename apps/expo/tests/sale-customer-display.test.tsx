// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { useSale } from '@tallyui/pos';
import { PortalHost } from '@tallyui/primitives';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useCustomerDisplay } from '../lib/customer-display-context';
import ProductsScreen from '../app/index';
import { openOrderStore } from '../lib/order-store';
import { useOutboxContext } from '../lib/outbox-context';
import { useRegister } from '../lib/register-context';
import { useSession } from '../lib/session-context';
import { sessionFixture } from './session-fixture';
import { fetchStoreSettings } from '../lib/store-settings';
import { useReplicatedProducts } from '../lib/use-replicated-products';
import { capabilities, storeSettings } from './pos-connector-mock';
import { openRegisterFixture } from './register-fixture';
import { setWindowWidth } from './window-width';

const { observed } = vi.hoisted(() => ({ observed: { sale: null as ReturnType<typeof useSale> | null } }));
vi.mock('../lib/pos-connector', async (original) => (await import('./pos-connector-mock')).mockPosConnector(original));
vi.mock('@tallyui/pos', async (original) => {
  const actual = await original<typeof import('@tallyui/pos')>();
  return { ...actual, useSale: (...args: Parameters<typeof actual.useSale>) => {
    const sale = actual.useSale(...args); observed.sale = sale; return sale;
  } };
});
vi.mock('expo-router', () => ({ usePathname: () => '/', Redirect: () => null, Stack: { Screen: () => null } }));
vi.mock('expo-linking', () => ({ openURL: vi.fn().mockResolvedValue(true) }));
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
beforeEach(async () => {
  setWindowWidth(1280);
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } });
  const session = { baseUrl: `https://display-${crypto.randomUUID()}.test`, email: 'admin@store.test', token: 'jwt',
    capabilities: { orderCreate: 7, taxRounding: { granularity: 'per_order' as const, mode: 'half_away_from_zero' as const } } };
  vi.mocked(useSession).mockReturnValue(sessionFixture(session));
  capabilities.mockResolvedValue(session.capabilities);
  storeSettings.mockResolvedValue({ currency: 'EUR', pricesIncludeTax: false, taxRatesPpm: { default: 250000 },
    pricingContext: { region_id: 'reg_eu', currency_code: 'eur', publishable_key: 'pk_1' } });
  vi.mocked(fetchStoreSettings).mockResolvedValue({ storeName: 'Test shop', currency: 'EUR',
    location: { id: 'loc', name: 'Main', countryCode: 'dk' } });
  vi.mocked(useRegister).mockReturnValue(openRegisterFixture());
  vi.mocked(useReplicatedProducts).mockReturnValue({ products: [{ id: 'shirt', title: 'Shirt', status: 'published',
    variants: [{ id: 'blue', title: 'Blue', sku: 'BLUE', prices: [{ amount: 12, currency_code: 'eur' }] }] }],
    state: 'synced', error: null, lastSyncedAt: null, stockOverlay: undefined, lastStockCheckAt: null,
    reconcileStock: vi.fn(async () => {}), pullNotice: undefined, resumePull: vi.fn(), syncNow: vi.fn(), clearAndRefresh: vi.fn(), unlisted: undefined });
  store = await openOrderStore(session.baseUrl);
  vi.mocked(useOutboxContext).mockReturnValue({ orders: store.orders, record: vi.fn(), state: { pending: 0, sending: false },
    recent: [], savesInFlight: 0, stuckCommandIds: [], flush: vi.fn(), requeue: vi.fn(), discard: vi.fn(), cancelOnStore: vi.fn(), payRestOnStore: vi.fn(), reverseOnStore: vi.fn(), isStored: vi.fn() });
});
afterEach(async () => {
  cleanup(); await store.close(); vi.unstubAllGlobals(); vi.resetAllMocks(); observed.sale = null;
});

vi.mock('../lib/customer-display-context', () => ({ useCustomerDisplay: vi.fn() }));
const service = { status: 'online' as const, displays: [], pauseReason: null, showCart: vi.fn(), showPayment: vi.fn(),
  close: vi.fn(), onChange: () => () => {}, refresh: async () => {} };
async function addShirt(available = true) {
  vi.mocked(useCustomerDisplay).mockReturnValue({ available, service: available ? service : null, pairing: null, startPairing: () => {} });
  await act(async () => { render(<><ProductsScreen /><PortalHost /></>); });
  fireEvent.click(await screen.findByTestId('product-tile-Shirt'));
}

it('SD-1: adding Shirt publishes its receipt line', async () => {
  await addShirt();
  expect(service.showCart.mock.lastCall?.[0]).toMatchObject({ lineItems: [{ name: 'Shirt' }] });
});

it('SD-2: the live sale keeps its customer and note, but neither reaches the display', async () => {
  await addShirt();
  const customer = { id: 'ada', name: 'Ada Lovelace', email: 'ada@example.test' };
  act(() => { observed.sale!.setCustomer(customer); observed.sale!.setNote('staff only: hold'); });
  expect(observed.sale!.order).toMatchObject({ customer, note: 'staff only: hold' });
  expect(JSON.stringify([service.showCart.mock.calls, service.showPayment.mock.calls])).not.toMatch(/Ada|ada@example\.test|staff only/);
  expect(service.showCart.mock.lastCall?.[0]).toMatchObject({ lineItems: [{ name: 'Shirt' }] });
});

it('SD-3: the sale still takes items with no display service', async () => {
  await addShirt(false);
  expect(observed.sale!.order.lineItems).toMatchObject([{ name: 'Shirt' }]);
  expect(service.showCart).not.toHaveBeenCalled(); expect(service.showPayment).not.toHaveBeenCalled();
});
