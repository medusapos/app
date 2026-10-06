// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { PortalHost } from '@tallyui/primitives';
import { type PosOrder } from '@tallyui/pos';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ProductsScreen from '../app/index';
import { openOrderStore } from '../lib/order-store';
import { useOutboxContext } from '../lib/outbox-context';
import { useRegister } from '../lib/register-context';
import { useSession } from '../lib/session-context';
import { fetchStoreSettings } from '../lib/store-settings';
import { useReplicatedProducts } from '../lib/use-replicated-products';
import { capabilities, storeSettings } from './pos-connector-mock';
import { openRegisterFixture } from './register-fixture';
import { setWindowWidth } from './window-width';

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
const record = vi.fn(async (_order: PosOrder) => {});
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
beforeEach(async () => {
  setWindowWidth(1280);
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  });
  const session = { baseUrl: `https://charges-${crypto.randomUUID()}.test`, email: 'admin@store.test', token: 'jwt',
    capabilities: { orderCreate: 5, taxRounding: { granularity: 'per_order' as const, mode: 'half_away_from_zero' as const },
      lineTax: { none: false, classes: false } } };
  vi.mocked(useSession).mockReturnValue({ session, signIn: vi.fn(), signOut: vi.fn(), reportUnauthorized: vi.fn(),
    mergeCapabilities: vi.fn(), setSaleHold: vi.fn(), setSavesHold: vi.fn(), signOutDeferred: false });
  capabilities.mockResolvedValue(session.capabilities);
  // Inclusive prices make a €2.00 charge increase the payable total by €2.00.
  storeSettings.mockResolvedValue({ currency: 'EUR', pricesIncludeTax: true, taxRatesPpm: { default: 250000 },
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
  vi.clearAllMocks();
});
async function start() {
  await act(async () => { render(<><ProductsScreen /><PortalHost /></>); });
  await screen.findByTestId('product-tile-Shirt');
}
async function totalMinor() {
  await act(async () => { click('Cash'); });
  click('Split payment');
  const total = within(screen.getByTestId('split-tender-summary')).getByText(/^Total: /);
  const amount = Math.round(Number(total.textContent!.match(/(\d+\.\d{2})\D*$/)![1]) * 100);
  click('Back');
  return amount;
}

it('offers Add charge when the store accepts order.create 5', async () => {
  await start();
  expect(screen.getByRole('button', { name: 'Add charge' })).toBeTruthy();
});

it('hides Add charge from a store below order.create 5', async () => {
  const context = vi.mocked(useSession).getMockImplementation()!();
  const session = { ...context.session!, capabilities: { ...context.session!.capabilities, orderCreate: 4 } };
  vi.mocked(useSession).mockReturnValue({ ...context, session });
  capabilities.mockResolvedValue(session.capabilities);
  await start();
  expect(screen.queryByRole('button', { name: 'Add charge' })).toBeNull();
});

it('a fee added at the till shows in the cart and raises the total', async () => {
  await start();
  fireEvent.click(screen.getByTestId('product-tile-Shirt'));
  const before = await totalMinor();
  click('Add charge');
  const form = within(screen.getByTestId('charge-form'));
  fireEvent.change(form.getByLabelText('Name'), { target: { value: 'Gift wrap' } });
  fireEvent.change(form.getByLabelText('Amount'), { target: { value: '2.00' } });
  fireEvent.click(form.getByRole('button', { name: 'Apply' }));
  expect(screen.getByTestId('cart-fee-0').textContent).toContain('Gift wrap');
  expect(await totalMinor()).toBe(before + 200);
  click('Remove Gift wrap');
  expect(screen.queryByTestId('cart-fee-0')).toBeNull();
  expect(await totalMinor()).toBe(before);
}, 15000);
