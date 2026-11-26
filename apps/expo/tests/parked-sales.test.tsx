// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PortalHost } from '@tallyui/primitives';
import { saleLogger, type LogEntry, type PosOrder } from '@tallyui/pos';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ProductsScreen from '../app/index';
import { draftsCollection, openOrderStore } from '../lib/order-store';
import { useOutboxContext } from '../lib/outbox-context';
import { useRegister } from '../lib/register-context';
import { useSession } from '../lib/session-context';
import { sessionFixture } from './session-fixture';
import { fetchStoreSettings } from '../lib/store-settings';
import { useReplicatedProducts } from '../lib/use-replicated-products';
import { capabilities, storeSettings } from './pos-connector-mock';
import { openRegisterFixture } from './register-fixture';
import { setWindowWidth } from './window-width';
import { cartLine, cartLineCells } from './tender-pane';

vi.mock('../lib/pos-connector', async (original) => (await import('./pos-connector-mock')).mockPosConnector(original));
vi.mock('expo-router', () => ({ usePathname: () => '/', Redirect: () => null, Stack: { Screen: () => null } }));
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
const logged: LogEntry[] = [];
const button = (name: string | RegExp) => screen.getByRole('button', { name });
const add = () => fireEvent.click(screen.getByTestId('product-tile-Shirt'));
const drafts = () => draftsCollection(store.orders)!;
const row = (label: string) => within(screen.getByTestId('cart-footer')).getByText(label).parentElement!.textContent;
// TallyUI 4.0.0's cart tax row: the label, its Including/Excluding tax tag, then the amount.
const taxRow = () => within(screen.getByTestId('cart-footer')).getByTestId('cart-total-tax-0').textContent;
// TallyUI 3.19.0's popover editor: a line's Remove is in its quantity popover, its Discount (at 1280) in its price popover.
const lineAction = (popover: 'quantity' | 'price', action: string, name = 'Shirt') => {
  fireEvent.click(button(`Edit ${popover} of ${name}`)); fireEvent.click(button(`${action} ${name}`));
};
beforeEach(async () => {
  setWindowWidth(1280, 800);
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  });
  const session = { baseUrl: `https://parked-${crypto.randomUUID()}.test`, email: 'admin@store.test', token: 'jwt',
    capabilities: { orderCreate: 4, taxRounding: { granularity: 'per_order' as const, mode: 'half_away_from_zero' as const } } };
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
  vi.mocked(useOutboxContext).mockReturnValue({ orders: store.orders, record, state: { pending: 0, sending: false },
    recent: [], savesInFlight: 0, stuckCommandIds: [], flush: vi.fn(), requeue: vi.fn(), discard: vi.fn(), cancelOnStore: vi.fn(), payRestOnStore: vi.fn(), reverseOnStore: vi.fn(), isStored: vi.fn() });
  logged.length = 0;
  saleLogger.addSink({ id: 'parked-price-test', levels: ['info'], write: (entry) => { logged.push(entry); } });
});
afterEach(async () => {
  cleanup();
  saleLogger.removeSink('parked-price-test');
  await store.close();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
async function mount() {
  let view!: ReturnType<typeof render>;
  await act(async () => { view = render(<><ProductsScreen /><PortalHost /></>); });
  await screen.findByTestId('product-tile-Shirt');
  return view;
}
const whoTabs = () => screen.queryAllByTestId(/^open-sale-tab-.*-who$/);
async function park() {
  // The live sale already has its tab; once parked the cart is blank, so every tab is a parked sale's.
  const before = (await drafts().find().exec()).length;
  await act(async () => { fireEvent.click(screen.getByTestId('new-sale-tab')); });
  await waitFor(() => expect(whoTabs()).toHaveLength(before + 1));
}
// Resume the one parked sale from its tab.
async function resume() {
  const [draft] = await drafts().find().exec();
  await act(async () => { fireEvent.click(screen.getByTestId(`open-sale-tab-${draft.id}`)); });
}
function price(value = '10.00') {
  // v2's price popover (lineEditor="popover"): tap the line's price, key the new one in, Apply. It takes no reason.
  fireEvent.click(within(cartLine('Shirt')).getByTestId('price-popover-trigger'));
  for (const key of value) fireEvent.click(screen.getByTestId(`price-popover-keypad-key-${key === '.' ? 'decimal' : key}`));
  fireEvent.click(screen.getByTestId('price-popover-apply'));
}
async function complete() {
  // v2's cart foot: Checkout opens the tender on Cash; the Card terminal tile takes the whole balance.
  await act(async () => { fireEvent.click(screen.getByTestId('cart-checkout')); });
  fireEvent.click(screen.getByTestId('tender-method-external'));
  fireEvent.click(screen.getByTestId('tender-take'));
  await act(async () => { fireEvent.click(button('Complete sale')); });
  await waitFor(() => expect(record).toHaveBeenCalledOnce());
  return record.mock.calls[0][0];
}

it('parks the cart with New, starts an empty sale, and resumes the parked cart with its lines', async () => {
  await mount();
  add(); add();
  await park();
  expect(await drafts().find().exec()).toHaveLength(1);
  expect(screen.getByTestId('cart-empty')).toBeTruthy();
  expect(screen.queryByTestId('cart-footer')).toBeNull(); // the empty cart draws no foot
  add();
  expect(cartLineCells('Shirt')).toEqual(['1', 'Shirt', '€12.00', '€12.00']);
  lineAction('quantity', 'Remove');
  expect(screen.getByTestId('cart-empty')).toBeTruthy();
  await resume();
  expect(cartLineCells('Shirt')).toEqual(['2', 'Shirt', '€12.00', '€24.00']);
  expect(screen.getByTestId('cart-checkout').textContent).toBe('Checkout €30.00');
  expect(await drafts().find().exec()).toHaveLength(0);
  expect(record).not.toHaveBeenCalled();
});

it('a parked sale resumed after a catalogue price change is re-priced to today\'s price, with TallyUI\'s Prices changed note', async () => {
  const view = await mount();
  add();
  expect(cartLineCells('Shirt')).toEqual(['1', 'Shirt', '€12.00', '€12.00']);
  await park();
  const replicated = vi.mocked(useReplicatedProducts).mock.results.at(-1)!.value;
  const product = replicated.products[0];
  vi.mocked(useReplicatedProducts).mockReturnValue({ ...replicated, products: [{ ...product,
    variants: [{ ...product.variants[0], prices: [{ amount: 15, currency_code: 'eur' }] }] }] });
  view.rerender(<><ProductsScreen /><PortalHost /></>);
  await resume();
  expect(cartLineCells('Shirt')).toEqual(['1', 'Shirt', '€15.00', '€15.00']);
  expect([row('Subtotal'), taxRow()]).toEqual(['Subtotal€15.00', 'VAT 25%Excluding tax€3.75']);
  expect(screen.getByTestId('cart-checkout').textContent).toBe('Checkout €18.75');
  expect(screen.getByText("Prices changed since this sale was parked: 1 line updated to today's price.")).toBeTruthy();
});

it('a variant no longer in the catalogue keeps its parked price on resume', async () => {
  const view = await mount();
  add(); await park();
  const replicated = vi.mocked(useReplicatedProducts).mock.results.at(-1)!.value;
  vi.mocked(useReplicatedProducts).mockReturnValue({ ...replicated, products: [] });
  view.rerender(<><ProductsScreen /><PortalHost /></>);
  expect(screen.queryByTestId('product-tile-Shirt')).toBeNull();
  await resume();
  expect(cartLineCells('Shirt')).toEqual(['1', 'Shirt', '€12.00', '€12.00']);
  expect(screen.getByTestId('cart-checkout').textContent).toBe('Checkout €15.00');
  expect(screen.queryByText(/Prices changed/)).toBeNull();
});

it('an unchanged catalogue resumes at the same prices with no Prices changed note', async () => {
  await mount(); add(); await park();
  await resume();
  expect(cartLineCells('Shirt')).toEqual(['1', 'Shirt', '€12.00', '€12.00']);
  expect(screen.getByTestId('cart-checkout').textContent).toBe('Checkout €15.00');
  expect(screen.queryByText(/Prices changed/)).toBeNull();
});

it('each parked sale is a tab, and no count shows while the tabs fit', async () => {
  await mount();
  expect(screen.queryByTestId('open-orders-count')).toBeNull();
  for (const count of [1, 2]) {
    add();
    await park();
    expect(whoTabs()).toHaveLength(count);
    expect(screen.queryByTestId('open-orders-count')).toBeNull();
  }
});

it('the Price action on a line changes its unit price, and the line and total follow', async () => {
  await mount(); add(); add();
  lineAction('price', 'Discount');
  fireEvent.change(screen.getByLabelText('Discount value'), { target: { value: '10' } });
  fireEvent.click(button('Apply'));
  price();
  // TallyUI 3.14.0's Price cell strikes the regular price through ahead of the new unit price.
  expect(cartLineCells('Shirt')).toEqual(['2', 'Shirt', '€12.00€10.00', '€20.00']);
  expect(within(cartLine('Shirt')).getByLabelText('Regular price €12.00')).toBeTruthy();
  expect([row('Subtotal'), row('Discount'), taxRow()])
    .toEqual(['Subtotal€20.00', 'Discount−€2.00', 'VAT 25%Excluding tax€4.50']);
  expect(screen.getByTestId('cart-checkout').textContent).toBe('Checkout €22.50');
});

it('a sale with an edited price is recorded with that unitPriceMinor', async () => {
  await mount(); add(); price();
  const order = await complete();
  expect(order.lines).toEqual([expect.objectContaining({ unitPriceMinor: 1000, quantity: 1 })]);
  expect(order.totalMinor).toBe(1250);
});

it('logs the price change with from and to (the price popover asks no reason)', async () => {
  await mount(); add(); price();
  await park();
  const [draft] = await drafts().find().exec();
  const lineId = JSON.parse(draft.data).lineItems[0].id;
  expect(logged.filter((entry) => entry.message === 'Price changed')).toEqual([expect.objectContaining({ level: 'info',
    data: { lineId, fromMinor: 1200, toMinor: 1000 } })]);
});
