// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ConnectorUnauthorizedError, type TallyConnector } from '@tallyui/core';
import type { useSale } from '@tallyui/pos';
import { PortalHost } from '@tallyui/primitives';
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

const { searchCustomers, createCustomer, observed } = vi.hoisted(() => ({
  searchCustomers: vi.fn<NonNullable<TallyConnector['searchCustomers']>>(),
  createCustomer: vi.fn<NonNullable<TallyConnector['createCustomer']>>(),
  observed: { sale: null as ReturnType<typeof useSale> | null },
}));
vi.mock('../lib/pos-connector', async (original) => {
  const mock = await (await import('./pos-connector-mock')).mockPosConnector(original);
  return { ...mock, createPosConnector: () => ({ ...mock.createPosConnector(), searchCustomers, createCustomer }) };
});
// Observe the real hook's state, including any extra customer fields passed to it.
vi.mock('@tallyui/pos', async (original) => {
  const actual = await original<typeof import('@tallyui/pos')>();
  return { ...actual, useSale: (...args: Parameters<typeof actual.useSale>) => {
    const sale = actual.useSale(...args); observed.sale = sale; return sale;
  } };
});
vi.mock('expo-router', () => ({ Redirect: () => null, Stack: { Screen: () => null } }));
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
const customer = { id: 'cus_1', name: 'Ada Lovelace', email: 'ada@example.com', phone: '+44123456789' };
const summary = { id: customer.id, name: customer.name, email: customer.email };
const unauthorized = vi.fn();
const button = (name: string) => screen.getByRole('button', { name });
beforeEach(async () => {
  setWindowWidth(1280);
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } });
  const session = { baseUrl: `https://customers-${crypto.randomUUID()}.test`, email: 'admin@store.test', token: 'jwt',
    capabilities: { orderCreate: 4, taxRounding: { granularity: 'per_order' as const, mode: 'half_away_from_zero' as const } } };
  vi.mocked(useSession).mockReturnValue({ session, signIn: vi.fn(), signOut: vi.fn(), reportUnauthorized: unauthorized,
    mergeCapabilities: vi.fn(), setSaleHold: vi.fn(), setSavesHold: vi.fn(), signOutDeferred: false });
  capabilities.mockResolvedValue(session.capabilities);
  storeSettings.mockResolvedValue({ currency: 'EUR', pricesIncludeTax: false, taxRatesPpm: { default: 250000 },
    pricingContext: { region_id: 'reg_eu', currency_code: 'eur', publishable_key: 'pk_1' } });
  vi.mocked(fetchStoreSettings).mockResolvedValue({ storeName: 'Test shop', currency: 'EUR',
    location: { id: 'loc', name: 'Main', countryCode: 'dk' } });
  vi.mocked(useRegister).mockReturnValue(openRegisterFixture());
  vi.mocked(useReplicatedProducts).mockReturnValue({ products: [{ id: 'shirt', title: 'Shirt', status: 'published',
    variants: [{ id: 'blue', title: 'Blue', sku: 'BLUE', prices: [{ amount: 12, currency_code: 'eur' }] }] }],
    state: 'synced', error: null, lastSyncedAt: null, stockOverlay: undefined, lastStockCheckAt: null,
    reconcileStock: vi.fn(async () => {}), pullNotice: undefined, resumePull: vi.fn(), unlisted: undefined });
  store = await openOrderStore(session.baseUrl);
  vi.mocked(useOutboxContext).mockReturnValue({ orders: store.orders, record: vi.fn(), state: { pending: 0, sending: false },
    recent: [], savesInFlight: 0, stuckCommandIds: [], flush: vi.fn(), requeue: vi.fn(), isStored: vi.fn() });
  searchCustomers.mockResolvedValue([customer]);
  createCustomer.mockResolvedValue(customer);
});
afterEach(async () => {
  cleanup(); await store.close(); vi.unstubAllGlobals(); vi.resetAllMocks(); observed.sale = null;
});
async function mount() {
  let view!: ReturnType<typeof render>;
  await act(async () => { view = render(<><ProductsScreen /><PortalHost /></>); });
  await screen.findByTestId('product-tile-Shirt');
  fireEvent.click(button('Customer: Guest'));
  expect(screen.getByTestId('customer-dialog')).toBeTruthy();
  return view;
}
async function pick() {
  fireEvent.change(screen.getByLabelText('Search customers'), { target: { value: customer.email } });
  fireEvent.click(await screen.findByLabelText(`${customer.name}, ${customer.email}`));
}
function newCustomer() {
  fireEvent.click(button('New customer'));
  for (const [placeholder, value] of [['First name', 'Ada'], ['Last name', 'Lovelace'], ['email@example.com', customer.email], ['Phone number', customer.phone]]) {
    fireEvent.change(screen.getByPlaceholderText(placeholder), { target: { value } });
  }
}

it('searching and picking a customer sets it on the sale and the opener shows their name', async () => {
  await mount(); await pick();
  expect(searchCustomers).toHaveBeenCalledWith(expect.objectContaining({ headers: { Authorization: 'Bearer jwt' } }), customer.email);
  expect(observed.sale!.order.customer).toEqual(summary);
  expect(button('Customer: Ada Lovelace')).toBeTruthy();
  expect(screen.queryByTestId('customer-dialog')).toBeNull();
});

it('a created customer is set on the sale with only id, name and email', async () => {
  await mount(); newCustomer();
  await act(async () => { fireEvent.click(button('Save Customer')); });
  expect(createCustomer).toHaveBeenCalledWith(expect.objectContaining({ headers: { Authorization: 'Bearer jwt' } }),
    { firstName: 'Ada', lastName: 'Lovelace', email: customer.email, phone: customer.phone });
  expect(observed.sale!.order.customer).toEqual(summary);
  expect(button('Customer: Ada Lovelace')).toBeTruthy();
  expect(screen.queryByTestId('customer-dialog')).toBeNull();
});

it('Remove customer returns the sale to Guest', async () => {
  await mount(); await pick();
  fireEvent.click(button('Customer: Ada Lovelace'));
  fireEvent.click(button('Remove customer'));
  expect(observed.sale!.order.customer).toBeNull();
  expect(screen.getByText('Customer: Guest')).toBeTruthy();
  expect(screen.queryByText('Remove customer')).toBeNull();
});

it('a 401 from search goes to sign in again; a 403 does not', async () => {
  await mount();
  for (const status of [403, 401] as const) {
    unauthorized.mockClear();
    searchCustomers.mockRejectedValue(new ConnectorUnauthorizedError('Denied', status));
    fireEvent.change(screen.getByLabelText('Search customers'), { target: { value: String(status) } });
    await screen.findByText(status === 401 ? 'Sign in again to continue.' : "Your account isn't allowed to do this on this store. Ask the store owner.");
    expect(unauthorized).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
  }
  newCustomer();
  for (const status of [403, 401] as const) {
    unauthorized.mockClear();
    createCustomer.mockRejectedValue(new ConnectorUnauthorizedError('Denied', status));
    await act(async () => { fireEvent.click(button('Save Customer')); });
    expect(unauthorized).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
  }
  expect(vi.mocked(useSession).mock.results.at(-1)!.value.signOut).not.toHaveBeenCalled();
});

it('offline, the picker cannot search or create', async () => {
  const view = await mount(); newCustomer();
  const replicated = vi.mocked(useReplicatedProducts).mock.results.at(-1)!.value;
  vi.mocked(useReplicatedProducts).mockReturnValue({ ...replicated, state: 'offline' });
  view.rerender(<><ProductsScreen /><PortalHost /></>);
  expect(screen.getByText('Connect to search or add customers.')).toBeTruthy();
  expect((screen.getByLabelText('Search customers') as HTMLInputElement).readOnly).toBe(true);
  for (const label of ['New customer', 'Save Customer']) {
    expect(button(label).getAttribute('aria-disabled')).toBe('true'); fireEvent.click(button(label));
  }
  fireEvent.change(screen.getByLabelText('Search customers'), { target: { value: customer.email } });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
  expect(searchCustomers).not.toHaveBeenCalled();
  expect(createCustomer).not.toHaveBeenCalled();
  expect(observed.sale!.order.customer).toBeNull();
});
