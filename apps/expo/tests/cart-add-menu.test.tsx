// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { PortalHost } from '@tallyui/primitives';
import { cartLine } from './tender-pane';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
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

const { createCustomer, connectorOptions } = vi.hoisted(() => ({ createCustomer: vi.fn(), connectorOptions: { createCustomer: true } }));
vi.mock('../lib/pos-connector', async (original) => {
  const mocked = await (await import('./pos-connector-mock')).mockPosConnector(original);
  return { ...mocked, createPosConnector: () => {
    const { createCustomer: _real, ...connector } = mocked.createPosConnector();
    return connectorOptions.createCustomer ? { ...connector, createCustomer } : connector;
  } };
});
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
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
beforeEach(async () => {
  setWindowWidth(1280);
  connectorOptions.createCustomer = true;
  createCustomer.mockReset().mockResolvedValue({ id: 'nia', name: 'Nia', firstName: 'Nia', email: 'new@example.com' });
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  });
  const session = { baseUrl: `https://cart-add-${crypto.randomUUID()}.test`, email: 'admin@store.test', token: 'jwt',
    capabilities: { orderCreate: 5, taxRounding: { granularity: 'per_order' as const, mode: 'half_away_from_zero' as const },
      lineTax: { none: false, classes: false } } };
  vi.mocked(useSession).mockReturnValue(sessionFixture(session));
  capabilities.mockResolvedValue(session.capabilities);
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
  vi.mocked(useOutboxContext).mockReturnValue({ orders: store.orders, record: vi.fn(async () => {}), state: { pending: 0, sending: false },
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
function openMenu(name?: string) {
  fireEvent.click(screen.getByTestId('cart-add-menu'));
  if (name) fireEvent.click(screen.getByRole('menuitem', { name }));
}
const FIVE_ROWS = ['Add new customer', 'Add Miscellaneous Product', 'Add Fee', 'Add Discount', 'Add Shipping'];
it('lists the five actions in order and hides the inline controls', async () => {
  await start();
  fireEvent.click(screen.getByTestId('product-tile-Shirt'));
  expect(screen.queryByRole('button', { name: /^(Add charge|Order discount)$/ })).toBeNull();
  const trigger = screen.getByRole('button', { name: 'Add to cart' });
  expect(trigger.textContent).toBe('');
  expect(trigger.querySelector('svg')).toBeTruthy();
  openMenu();
  expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(FIVE_ROWS);
});
it('lists all five rows on an empty cart, Add Discount enabled', async () => {
  await start();
  openMenu();
  expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(FIVE_ROWS);
  expect(screen.getByRole('menuitem', { name: 'Add Discount' }).getAttribute('aria-disabled')).not.toBe('true');
});
it('marks the trigger open only while its menu is open', async () => {
  await start();
  const trigger = screen.getByTestId('cart-add-menu');
  expect(trigger.getAttribute('data-open')).toBe('false');
  openMenu();
  expect(trigger.getAttribute('data-open')).toBe('true');
  fireEvent.click(screen.getByRole('menuitem', { name: 'Add Fee' }));
  expect(screen.getByTestId('cart-add-menu').getAttribute('data-open')).toBe('false');
});
it('Add new customer creates the customer and makes it the sale\'s customer', async () => {
  await start();
  openMenu('Add new customer');
  const dialog = screen.getByTestId('new-customer-dialog');
  expect(within(dialog).getByText('Add new customer')).toBeTruthy();
  fireEvent.change(screen.getByPlaceholderText('email@example.com'), { target: { value: 'new@example.com' } });
  fireEvent.change(screen.getByPlaceholderText('First name'), { target: { value: 'Nia' } });
  await act(async () => { fireEvent.click(screen.getByTestId('customer-save')); });
  expect(createCustomer).toHaveBeenCalledExactlyOnceWith(expect.anything(), { email: 'new@example.com', firstName: 'Nia' });
  expect(screen.getByTestId('customer-chip').getAttribute('aria-label')).toBe('Customer: Nia');
  expect(screen.queryByTestId('new-customer-dialog')).toBeNull();
});
it('greys Add new customer when the connector cannot create customers', async () => {
  connectorOptions.createCustomer = false;
  await start();
  openMenu();
  const item = screen.getByRole('menuitem', { name: 'Add new customer' });
  expect(item.getAttribute('aria-disabled')).toBe('true');
  fireEvent.click(item);
  expect(screen.queryByTestId('new-customer-dialog')).toBeNull();
});
it.each([
  ['Add Fee', 'Add fee', 'Gift wrap'],
  ['Add Miscellaneous Product', 'Add custom item', 'Engraving'],
])('%s applies and closes the dialog', async (item, title, name) => {
  await start();
  openMenu(item);
  const form = within(screen.getByTestId('cart-add-dialog')).getByTestId('charge-form');
  expect(form.getAttribute('aria-label')).toBe(title);
  fireEvent.change(within(form).getByLabelText('Name'), { target: { value: name } });
  fireEvent.change(within(form).getByLabelText('Amount'), { target: { value: '2.00' } });
  click('Apply');
  expect((item === 'Add Fee' ? screen.getByTestId('cart-fee-0') : cartLine(name)).textContent).toContain(name);
  expect(screen.queryByTestId('cart-add-dialog')).toBeNull();
});
it('applies an order discount and closes the dialog', async () => {
  await start();
  fireEvent.click(screen.getByTestId('product-tile-Shirt'));
  openMenu('Add Discount');
  click('Percent');
  fireEvent.change(screen.getByLabelText('Discount value'), { target: { value: '10' } });
  click('Apply');
  expect(screen.getByRole('button', { name: /^Remove discount Order discount 10%/ })).toBeTruthy();
  expect(screen.queryByTestId('cart-add-dialog')).toBeNull();
});
it('below order.create 5 offers only Add new customer and a discount, on an empty cart too', async () => {
  const context = vi.mocked(useSession).getMockImplementation()!();
  const session = { ...context.session!, capabilities: { ...context.session!.capabilities, orderCreate: 4 } };
  vi.mocked(useSession).mockReturnValue({ ...context, session });
  capabilities.mockResolvedValue(session.capabilities);
  await start();
  openMenu();
  expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Add new customer', 'Add Discount']);
});
