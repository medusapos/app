// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PortalHost } from '@tallyui/primitives';
import { REGISTER_CLOSING, type PosOrder } from '@tallyui/pos';
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
import { cartLineCells } from './tender-pane';
import type { StoreOrder } from '@tallyui/core';
import { requestReopen } from '../lib/reopen-order';

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
const button = (name: string | RegExp) => screen.getByRole('button', { name });
const saleTabs = () => within(within(screen.getByTestId('open-sale-tabs')).getByRole('tablist'));
const add = () => fireEvent.click(screen.getByTestId('product-tile-Shirt'));
const drafts = () => draftsCollection(store.orders)!;
const newSale = () => act(async () => { fireEvent.click(screen.getByTestId('new-sale-tab')); });
// jsdom lays nothing out: these getters make the tabs' scroller 1000 wide inside 300, so the strip overflows.
const widths = { scrollWidth: 1000, clientWidth: 300 } as const;
const realWidths = Object.fromEntries(Object.keys(widths)
  .map((key) => [key, Object.getOwnPropertyDescriptor(HTMLElement.prototype, key)]));
function overflowTabs() {
  for (const [key, size] of Object.entries(widths)) Object.defineProperty(HTMLElement.prototype, key, {
    configurable: true, get(this: HTMLElement) { return this.getAttribute('role') === 'tablist' ? size : 0; } });
}
function fitTabs() {
  for (const [key, real] of Object.entries(realWidths)) {
    if (real) Object.defineProperty(HTMLElement.prototype, key, real);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
  }
}
async function parkTwo() {
  await mount();
  add(); await newSale();
  add(); await newSale();
  await waitFor(() => expect(screen.getAllByTestId(/^open-sale-tab-.*-who$/)).toHaveLength(2));
  return (await drafts().find().exec()).map((draft) => draft.id).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

beforeEach(async () => {
  setWindowWidth(1280, 800);
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  });
  const session = { baseUrl: `https://open-tabs-${crypto.randomUUID()}.test`, email: 'admin@store.test', token: 'jwt',
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
    recent: [], savesInFlight: 0, stuckCommandIds: [], flush: vi.fn(), requeue: vi.fn(), discard: vi.fn(), isStored: vi.fn() });
});
afterEach(async () => {
  cleanup();
  fitTabs();
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

it('shows an empty tab strip and New for a blank cart', async () => {
  await mount();
  expect(screen.getByTestId('open-sale-tabs')).toBeTruthy();
  expect(screen.queryAllByTestId(/^open-sale-tab-/)).toHaveLength(0);
  expect(within(screen.getByTestId('new-sale-tab')).getByText('New')).toBeTruthy();
});

it('shows no count when nothing is parked, and no header link', async () => {
  await mount();
  expect(screen.queryByTestId('open-orders-count')).toBeNull();
  expect(screen.queryByText('Parked sales')).toBeNull();
});

it('with a parked sale whose tabs fit, no count shows: its tab is the way back', async () => {
  await mount(); add(); await newSale();
  const [draft] = await drafts().find().exec();
  await waitFor(() => expect(screen.getAllByTestId(/^open-sale-tab-.*-who$/)).toHaveLength(1));
  expect(screen.queryByTestId('open-orders-count')).toBeNull();
  await act(async () => { fireEvent.click(screen.getByTestId(`open-sale-tab-${draft.id}`)); });
  expect(cartLineCells('Shirt')).toEqual(['1', 'Shirt', '€12.00', '€12.00']);
});

it('when the tabs overflow, the count sits left of the tabs and opens the Open orders list in the cart\'s place', async () => {
  overflowTabs();
  const ids = await parkTwo();
  const count = await screen.findByTestId('open-orders-count');
  expect(count.textContent).toBe('2 ▴');
  expect(button('Open orders (2)')).toBe(count);
  expect(count.parentElement?.firstElementChild).toBe(count);
  expect(count.nextElementSibling).toBe(screen.getByTestId('open-sale-tabs').parentElement);
  expect(screen.queryByTestId('open-orders-list')).toBeNull();
  expect(screen.queryByTestId('parked-sales')).toBeNull();
  const amount = screen.getByTestId(`open-sale-tab-${ids[0]}-amount`).textContent;
  fireEvent.click(count);
  const list = within(await screen.findByTestId('open-orders-list'));
  expect(list.getAllByTestId(/^open-orders-row-.*-who$/).map((who) => who.getAttribute('data-testid')))
    .toEqual(ids.map((id) => `open-orders-row-${id}-who`));
  for (const id of ids) {
    expect(list.getByTestId(`open-orders-row-${id}-who`).textContent).toBe('Guest');
    expect(list.getByTestId(`open-orders-row-${id}-items`).textContent).toBe('Shirt');
    expect(list.getByTestId(`open-orders-row-${id}-total`).textContent).toBe(amount);
  }
  expect(amount).toBe('€15.00');
  expect(screen.queryByTestId('cart-empty')).toBeNull();
  expect(screen.getByTestId('open-orders-count').textContent).toBe('2 ▾');
});

it('a row switches to its sale and closes the list', async () => {
  overflowTabs();
  const [first] = await parkTwo();
  fireEvent.click(await screen.findByTestId('open-orders-count'));
  await act(async () => { fireEvent.click(await screen.findByTestId(`open-orders-row-${first}`)); });
  expect(screen.queryByTestId('open-orders-list')).toBeNull();
  expect(cartLineCells('Shirt')).toEqual(['1', 'Shirt', '€12.00', '€12.00']);
  expect(screen.getByTestId(`open-sale-tab-${first}`).getAttribute('aria-selected')).toBe('true');
});

it('the list marks only the sale on screen, and the mark moves with a switch', async () => {
  overflowTabs();
  const ids = await parkTwo();
  const selected = () => ids.map((id) => screen.getByTestId(`open-orders-row-${id}`).getAttribute('aria-selected'));
  for (const [index, id] of ids.entries()) {
    fireEvent.click(await screen.findByTestId('open-orders-count'));
    await act(async () => { fireEvent.click(await screen.findByTestId(`open-orders-row-${id}`)); });
    expect(screen.queryByTestId('open-orders-list')).toBeNull();
    fireEvent.click(screen.getByTestId('open-orders-count'));
    await screen.findByTestId('open-orders-list');
    await waitFor(() => expect(selected()).toEqual(ids.map((_, i) => String(i === index))));
    fireEvent.click(screen.getByTestId('open-orders-close'));
  }
});

it('a row shows its sale\'s customer, and a guest sale\'s row says Guest', async () => {
  overflowTabs();
  const [withCustomer, guest] = await parkTwo();
  // Seed the parked draft as parkDraft writes a sale on a customer: the snapshot's customer and its summary name.
  const doc = await drafts().findOne(withCustomer).exec(true);
  const snapshot = JSON.parse(doc.get('data') as string);
  await doc.incrementalPatch({ customerName: 'Ada Lovelace',
    data: JSON.stringify({ ...snapshot, customer: { id: 'ada', name: 'Ada Lovelace', email: 'ada@example.test' } }) });
  fireEvent.click(await screen.findByTestId('open-orders-count'));
  const list = within(await screen.findByTestId('open-orders-list'));
  await waitFor(() => expect(list.getByTestId(`open-orders-row-${withCustomer}-who`).textContent).toBe('Ada Lovelace'));
  expect(list.getByTestId(`open-orders-row-${guest}-who`).textContent).toBe('Guest');
});

it('Close and a second tap on the count both close the list', async () => {
  overflowTabs();
  await parkTwo();
  const count = await screen.findByTestId('open-orders-count');
  fireEvent.click(count);
  fireEvent.click(await screen.findByTestId('open-orders-close'));
  expect(screen.queryByTestId('open-orders-list')).toBeNull();
  expect(screen.getByTestId('cart-empty')).toBeTruthy();
  fireEvent.click(count);
  expect(await screen.findByTestId('open-orders-list')).toBeTruthy();
  fireEvent.click(count);
  expect(screen.queryByTestId('open-orders-list')).toBeNull();
  expect(count.textContent).toBe('2 ▴');
});

it('the count hides, and an open list closes, when the tabs fit again', async () => {
  overflowTabs();
  const [first] = await parkTwo();
  fireEvent.click(await screen.findByTestId('open-orders-count'));
  expect(await screen.findByTestId('open-orders-list')).toBeTruthy();
  fitTabs();
  await act(async () => { fireEvent.click(screen.getByTestId(`open-sale-tab-${first}`)); });
  await waitFor(() => expect(screen.queryByTestId('open-orders-count')).toBeNull());
  expect(screen.queryByTestId('open-orders-list')).toBeNull();
});

it('shows the added line as a selected Guest · Shirt tab', async () => {
  await mount(); add();
  const tabs = saleTabs().getAllByRole('tab');
  expect(tabs).toHaveLength(1);
  expect(tabs[0].getAttribute('aria-selected')).toBe('true');
  expect(within(tabs[0]).getByTestId(/-who$/).textContent).toBe('Guest · Shirt');
});

it('parks the current sale with New, keeping its unselected tab', async () => {
  await mount(); add();
  const tabId = saleTabs().getByRole('tab').getAttribute('data-testid')!;
  await act(async () => { fireEvent.click(screen.getByTestId('new-sale-tab')); });
  expect(screen.getByTestId('cart-empty')).toBeTruthy();
  const parked = await drafts().find().exec();
  expect(parked).toHaveLength(1);
  expect(tabId).toBe(`open-sale-tab-${parked[0].id}`);
  await waitFor(() => expect(screen.getByTestId(tabId).getAttribute('aria-selected')).toBe('false'));
  expect(saleTabs().getAllByRole('tab')).toHaveLength(1);
  expect(within(screen.getByTestId('new-sale-tab')).getByText('New')).toBeTruthy();
});

it('resumes a parked tab without recording an order', async () => {
  await mount(); add();
  await act(async () => { fireEvent.click(screen.getByTestId('new-sale-tab')); });
  const [draft] = await drafts().find().exec();
  const tabId = `open-sale-tab-${draft.id}`;
  await screen.findByTestId(tabId);
  await act(async () => { fireEvent.click(screen.getByTestId(tabId)); });
  expect(cartLineCells('Shirt')).toEqual(['1', 'Shirt', '€12.00', '€12.00']);
  expect(screen.getByTestId(tabId).getAttribute('aria-selected')).toBe('true');
  expect(await drafts().find().exec()).toHaveLength(0);
  expect(record).not.toHaveBeenCalled();
});

it('keeps three tabs in creation order and one draft per non-current sale across switches', async () => {
  await mount();
  const tabIds: string[] = [];
  for (const quantity of [1, 2, 3]) {
    for (let count = 0; count < quantity; count++) add();
    const tab = saleTabs().getByRole('tab', { selected: true });
    tabIds.push(tab.getAttribute('data-testid')!);
    if (quantity < 3) {
      await act(async () => { fireEvent.click(screen.getByTestId('new-sale-tab')); });
      expect(screen.getByTestId('cart-empty')).toBeTruthy();
      await waitFor(async () => expect(await drafts().find().exec()).toHaveLength(quantity));
    }
  }
  await waitFor(() => expect(saleTabs().getAllByRole('tab')
    .map((tab) => tab.getAttribute('data-testid'))).toEqual(tabIds));
  expect((await drafts().find().exec()).map((draft) => `open-sale-tab-${draft.id}`).sort()).toEqual(tabIds.slice(0, 2).sort());
  for (const index of [0, 1]) {
    await act(async () => { fireEvent.click(screen.getByTestId(tabIds[index])); });
    await waitFor(() => expect(saleTabs().getAllByRole('tab')
      .map((tab) => tab.getAttribute('data-testid'))).toEqual(tabIds));
    expect(saleTabs().getAllByRole('tab')
      .map((tab) => tab.getAttribute('aria-selected'))).toEqual(tabIds.map((_, i) => String(i === index)));
    expect(cartLineCells('Shirt')).toEqual([String(index + 1), 'Shirt', '€12.00', index === 0 ? '€12.00' : '€24.00']);
    expect((await drafts().find().exec()).map((draft) => `open-sale-tab-${draft.id}`).sort())
      .toEqual(tabIds.filter((_, i) => i !== index).sort());
  }
  expect(record).not.toHaveBeenCalled();
});

it.each([1280, 390])('hides tabs during tender and restores the same tab on cancel at width %i', async (width) => {
  setWindowWidth(width, 800);
  await mount(); add();
  if (width === 390) fireEvent.click(screen.getByRole('tab', { name: /^Cart, / }));
  const tabId = saleTabs().getByRole('tab').getAttribute('data-testid')!;
  await act(async () => { fireEvent.click(screen.getByTestId('cart-checkout')); });
  expect(screen.getByTestId('tender-pane')).toBeTruthy();
  expect(screen.queryByTestId('open-sale-tabs')).toBeNull();
  fireEvent.click(button('Back'));
  expect(screen.queryByTestId('tender-pane')).toBeNull();
  expect(screen.getByTestId('open-sale-tabs')).toBeTruthy();
  expect(saleTabs().getAllByRole('tab')).toHaveLength(1);
  expect(screen.getByTestId(tabId).getAttribute('aria-selected')).toBe('true');
});

// Orders' Reopen (row 10.3): the store order's lines and customer as a new tab, the open sale parked beside it.
const storeOrder = (lines: [string, string | undefined, number][]): StoreOrder => ({
  id: 'order_7', reference: '1007', status: 'completed', placedAt: '2026-11-24T09:00:00.000Z', currency: 'EUR',
  pricesIncludeTax: false, customer: { id: 'ada', name: 'Ada Lovelace', email: 'ada@example.test' },
  lines: lines.map(([name, variantId, quantity]) => ({ id: `line_${name}`, name, variantId, quantity,
    subtotalMinor: 0, subtotalTaxMinor: 0, totalMinor: 0, taxMinor: 0 })),
  fees: [], shipping: [], coupons: [], taxLines: [], discountMinor: 0, discountTaxMinor: 0, taxMinor: 0, totalMinor: 0,
  payments: [], refunds: [],
});
function withHat() {
  const replicated = (useReplicatedProducts as unknown as () => ReturnType<typeof useReplicatedProducts>)(); // the beforeEach value
  vi.mocked(useReplicatedProducts).mockReturnValue({ ...replicated, products: [...replicated.products, { id: 'hat', title: 'Hat',
    status: 'published', variants: [{ id: 'red', title: 'Red', sku: 'RED', prices: [{ amount: 5, currency_code: 'eur' }] }] }] });
}

it("a reopen request parks the open sale and starts a new tab with the order's lines, quantities and customer", async () => {
  withHat();
  await mount(); add();
  const parkedTab = saleTabs().getByRole('tab').getAttribute('data-testid')!;
  await act(async () => { requestReopen(storeOrder([['Hat', 'red', 3], ['Shirt', 'blue', 1]])); });
  await waitFor(() => expect(saleTabs().getAllByRole('tab')).toHaveLength(2));
  expect(await drafts().find().exec()).toHaveLength(1);
  expect(screen.getByTestId(parkedTab).getAttribute('aria-selected')).toBe('false');
  expect(cartLineCells('Hat')).toEqual(['3', 'Hat', '€5.00', '€15.00']);
  expect(cartLineCells('Shirt')).toEqual(['1', 'Shirt', '€12.00', '€12.00']);
  const current = saleTabs().getAllByRole('tab').find((tab) => tab.getAttribute('aria-selected') === 'true')!;
  expect(within(current).getByTestId(/-who$/).textContent).toBe('Ada Lovelace');
  expect(screen.queryByTestId('open-sale-refusal')).toBeNull();
});

it('a refused reopen shows why and keeps the open sale', async () => {
  await mount(); add();
  await act(async () => { requestReopen(storeOrder([['Shirt', 'blue', 2], ['Old scarf', 'gone', 1]])); });
  expect(screen.getByTestId('open-sale-refusal').textContent).toBe('Can\'t reopen: "Old scarf" is no longer for sale.');
  expect(cartLineCells('Shirt')).toEqual(['1', 'Shirt', '€12.00', '€12.00']);
  expect(saleTabs().getAllByRole('tab')).toHaveLength(1);
  expect(await drafts().find().exec()).toHaveLength(0);
});

it('a reopen while the register is counting is refused and starts no tab', async () => {
  const view = await mount(); add();
  const fixture = openRegisterFixture();
  vi.mocked(useRegister).mockReturnValue({ ...fixture, register: { ...fixture.register,
    session: { ...fixture.register.session!, status: 'counting' } } });
  await act(async () => { view.rerender(<><ProductsScreen /><PortalHost /></>); });
  await act(async () => { requestReopen(storeOrder([['Shirt', 'blue', 2]])); });
  vi.mocked(useRegister).mockReturnValue(openRegisterFixture());
  await act(async () => { view.rerender(<><ProductsScreen /><PortalHost /></>); });
  expect(screen.getByTestId('open-sale-refusal').textContent).toBe(REGISTER_CLOSING);
  expect(saleTabs().getAllByRole('tab')).toHaveLength(1);
  expect(cartLineCells('Shirt')).toEqual(['1', 'Shirt', '€12.00', '€12.00']);
  expect(await drafts().find().exec()).toHaveLength(0);
});

it('a line the cart refuses stops the reopen and says the tab is partial', async () => {
  withHat();
  const replicated = (useReplicatedProducts as unknown as () => ReturnType<typeof useReplicatedProducts>)();
  vi.mocked(useReplicatedProducts).mockReturnValue({ ...replicated, products: [...replicated.products, { id: 'cap', title: 'Cap',
    status: 'published', variants: [{ id: 'cap-std', title: 'Std', sku: 'CAP', prices: [{ amount: 5, currency_code: 'usd' }] }] }] });
  await mount(); add();
  await act(async () => { requestReopen(storeOrder([['Shirt', 'blue', 2], ['Cap', 'cap-std', 1], ['Hat', 'red', 1]])); });
  expect(screen.getByTestId('open-sale-refusal').textContent).toBe('Reopened only part of order #1007: No EUR price for Cap');
  expect(saleTabs().getAllByRole('tab')).toHaveLength(2);
  expect(cartLineCells('Shirt')).toEqual(['2', 'Shirt', '€12.00', '€24.00']);
  const cart = within(screen.getByTestId('cart-header').parentElement!);
  expect(cart.queryByText('Cap')).toBeNull();
  expect(cart.queryByText('Hat')).toBeNull();
  const current = saleTabs().getByRole('tab', { selected: true });
  expect(within(current).getByTestId(/-who$/).textContent).toBe('Ada Lovelace');
});
