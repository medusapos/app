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
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
beforeEach(async () => {
  setWindowWidth(1280);
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
it('lists the four actions in order and hides the inline controls', async () => {
  await start();
  fireEvent.click(screen.getByTestId('product-tile-Shirt'));
  expect(screen.queryByRole('button', { name: /^(Add charge|Order discount)$/ })).toBeNull();
  expect(screen.getByRole('button', { name: 'Add to cart' }).textContent).toBe('+');
  openMenu();
  expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
    'Add Miscellaneous Product', 'Add Fee', 'Add Discount', 'Add Shipping',
  ]);
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
it('below order.create 5 offers only a discount with lines and no trigger without lines', async () => {
  const context = vi.mocked(useSession).getMockImplementation()!();
  const session = { ...context.session!, capabilities: { ...context.session!.capabilities, orderCreate: 4 } };
  vi.mocked(useSession).mockReturnValue({ ...context, session });
  capabilities.mockResolvedValue(session.capabilities);
  await start();
  expect(screen.queryByTestId('cart-add-menu')).toBeNull();
  fireEvent.click(screen.getByTestId('product-tile-Shirt'));
  openMenu();
  expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Add Discount']);
});
