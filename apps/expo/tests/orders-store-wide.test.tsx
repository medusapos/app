// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { orderReference } from '@tallyui/components';
import { PortalHost } from '@tallyui/primitives';
import { ConnectorUnauthorizedError, CustomerServiceError, formatMoney, type OrderFilterField, type ServerCapabilities,
  type StoreOrder, type StoreOrderPage } from '@tallyui/core';
import { createOrderBuilder, finalizeOrder, type PosOrder } from '@tallyui/pos';
import { REGISTER_ID_KEY, type Session } from '../lib/session';
import { saveTillName } from '../lib/till-name';
import { useOutboxContext } from '../lib/outbox-context';
import { formatDate } from '../lib/format-date';
import { takeReopen } from '../lib/reopen-order';
import { router } from 'expo-router';
import { StoreOrderDetailSheet } from '../components/store-order-detail-sheet';
import OrdersScreen, { ORDERS_EMPTY_TEXT, ORDERS_FAILED_TEXT, ORDERS_LOADING_TEXT, ORDERS_NO_MATCH_TEXT, ORDERS_OFFLINE_TEXT }
  from '../app/orders';
import { setWindowWidth } from './window-width';

const { listOrders, sessionState, connector } = vi.hoisted(() => ({
  listOrders: vi.fn(),
  sessionState: { session: null as Session | null, reportUnauthorized: vi.fn() },
  connector: { orderFilters: null as OrderFilterField[] | null },
}));
vi.mock('expo-router', () => ({
  Redirect: ({ href }: { href: string }) => <span>redirect:{href}</span>,
  router: { replace: vi.fn(), push: vi.fn(), dismissTo: vi.fn() }, usePathname: () => '/orders',
  Stack: { Screen: () => null },
}));
vi.mock('../lib/pos-connector', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/pos-connector')>();
  return {
    createPosConnector: () => ({ id: 'medusa', listOrders }),
    authHeaders: () => ({ Authorization: 'Bearer t' }),
    // A test may stand in its own filter list; otherwise the real plugin-contract gate decides.
    storeOrderFilters: (capabilities?: ServerCapabilities) => connector.orderFilters ?? actual.storeOrderFilters(capabilities),
  };
});
vi.mock('../lib/session-context', () => ({ useSession: () => sessionState }));
vi.mock('../lib/outbox-context', () => ({ useOutboxContext: vi.fn() }));
vi.mock('expo-linking', () => ({ openURL: vi.fn().mockResolvedValue(true) }));
// react-native-web drops className without NativeWind, so TableHead and TableCell echo it as data-class for the width check.
vi.mock('@tallyui/components', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tallyui/components')>();
  const { forwardRef } = await import('react');
  const echo = (Actual: typeof actual.TableCell) =>
    forwardRef<never, Parameters<typeof Actual>[0]>((props, ref) => <Actual ref={ref} {...props} dataSet={{ class: props.className ?? '' }} />);
  return { ...actual, TableHead: echo(actual.TableHead), TableCell: echo(actual.TableCell) };
});

const context = { connectorId: 'medusa', baseUrl: 'https://store.test', headers: { Authorization: 'Bearer t' } };

function sale(name: string, syncStatus: PosOrder['syncStatus'], createdAt = '2026-11-24T11:00:00.000Z'): PosOrder {
  const builder = createOrderBuilder({ currency: 'EUR', taxContext: { pricesIncludeTax: false, getTaxRatePpm: () => 0 } });
  builder.addLine({ productId: name, variantId: name, name, unitPrice: { amount: 1200, currency: 'EUR' } });
  builder.addPayment({ method: 'cash', amountMinor: 1200 });
  return { ...finalizeOrder(builder.getSnapshot()), syncStatus, createdAt };
}
function storeOrder(n: number, extra: Partial<StoreOrder> = {}): StoreOrder {
  return {
    id: `order_${n}`, reference: String(1000 + n), status: 'completed', placedAt: `2026-11-2${n % 4}T09:00:00.000Z`,
    currency: 'EUR', pricesIncludeTax: false, customer: { id: 'ada', name: 'Ada Lovelace' },
    lines: [{ id: `line_${n}`, name: 'Blue shirt', quantity: 1, subtotalMinor: 1500, subtotalTaxMinor: 0, totalMinor: 1500, taxMinor: 0 }],
    fees: [], shipping: [], coupons: [], taxLines: [], discountMinor: 0, discountTaxMinor: 0, taxMinor: 0, totalMinor: 1500,
    payments: [{ id: `pay_${n}`, method: 'Card reader', amountMinor: 1500 }], refunds: [], ...extra,
  };
}
const page = (orders: StoreOrder[], extra: Partial<StoreOrderPage> = {}): StoreOrderPage => ({ orders, hasMore: false, ...extra });
// The billing read goes to Medusa's /admin/orders through fetch, stubbed for every test so none reaches a network.
const billingFetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
const billingAnswer = (orders: unknown[], status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => ({ orders }) }) as unknown as Response;
const address = (id: string, street: string, billing_address: unknown = { address_1: street, city: 'Copenhagen', country_code: 'dk' }) =>
  ({ id, billing_address });
// Holds each billing read until the test answers it, in the order they were sent.
function holdBilling() {
  const reads: ((answer: Response) => void)[] = [];
  billingFetch.mockImplementation(() => new Promise((resolve) => { reads.push(resolve); }));
  return reads;
}
function withSales(...recent: PosOrder[]) {
  vi.mocked(useOutboxContext).mockReturnValue({
    orders: null, state: { pending: 0, sending: false }, recent, savesInFlight: 0, stuckCommandIds: [],
    record: vi.fn().mockResolvedValue(undefined), flush: vi.fn().mockResolvedValue(undefined),
    requeue: vi.fn().mockResolvedValue(0), discard: vi.fn(), cancelOnStore: vi.fn(), payRestOnStore: vi.fn(), isStored: vi.fn().mockResolvedValue(false),
  });
}
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
async function mount() {
  const view = render(<><OrdersScreen /><PortalHost /></>);
  await settle();
  return view;
}
const cell = (key: string, name: string) => screen.getByTestId(`orders-row-${key}-${name}`).textContent;
const openButtons = () => within(screen.getByTestId('orders-table')).getAllByRole('button', { name: /^Open order / })
  .map((button) => button.getAttribute('aria-label'));

beforeEach(() => {
  // These are the table's tests; below 600 px Orders draws phone rows (orders-screen.test.tsx).
  setWindowWidth(1024, 768);
  vi.useFakeTimers();
  listOrders.mockReset().mockResolvedValue(page([]));
  billingFetch.mockReset().mockImplementation(async () => billingAnswer([]));
  vi.stubGlobal('fetch', billingFetch);
  connector.orderFilters = null;
  sessionState.session = { baseUrl: 'https://store.test', email: 'admin@store.test', token: 't' };
  withSales();
  // This till's device id, the one its sales carry (getDeviceId reads it from here); no till name saved.
  const data = new Map<string, string>([[REGISTER_ID_KEY, 'till-a']]);
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe('Orders lists the whole store (row 10)', () => {
  it('lists the store\'s orders in the store\'s order with their cells; a guest reads Guest, the cashier —', async () => {
    const newer = storeOrder(2, { status: 'requires_action' });
    const guest = storeOrder(1, { customer: null });
    listOrders.mockResolvedValue(page([newer, guest]));
    await mount();
    expect(listOrders).toHaveBeenCalledExactlyOnceWith(context, { page: 1, perPage: 25 });
    expect(openButtons()).toEqual(['Open order #1002', 'Open order #1001']);
    expect(cell('order_2', 'status')).toBe('On hold');
    expect(cell('order_2', 'number')).toBe('#1002');
    expect(cell('order_2', 'customer')).toBe('Ada Lovelace');
    expect(cell('order_2', 'date')).toBe(formatDate(newer.placedAt));
    expect(cell('order_2', 'cashier')).toBe('—');
    expect(cell('order_2', 'payment')).toBe('—');
    expect(cell('order_2', 'total')).toBe(formatMoney({ amount: 1500, currency: 'EUR' }));
    expect(cell('order_1', 'customer')).toBe('Guest');
    expect(cell('order_1', 'status')).toBe('Completed');
  });

  it('a store order this till rang up is one row, the till\'s own', async () => {
    const mine = sale('Red hat', 'applied');
    withSales(mine);
    listOrders.mockResolvedValue(page([storeOrder(9, { clientOrderId: mine.id }), storeOrder(8)]));
    await mount();
    expect(screen.getAllByTestId(`orders-row-${mine.id}`)).toHaveLength(1);
    expect(screen.queryByTestId('orders-row-order_9')).toBeNull();
    expect(cell(mine.id, 'number')).toBe(orderReference(mine));
    expect(openButtons()).toEqual([`Open order ${orderReference(mine)}`, 'Open order #1008']);
  });

  it('a sale not yet in the store is above the store\'s orders, and its arrival reads page 1 again', async () => {
    const pending = sale('Red hat', 'pending');
    withSales(pending);
    listOrders.mockResolvedValue(page([storeOrder(1)]));
    const view = await mount();
    expect(openButtons()).toEqual([`Open order ${orderReference(pending)}`, 'Open order #1001']);
    expect(cell(pending.id, 'status')).toBe('Pending');
    const applied = { ...pending, syncStatus: 'applied' as const };
    withSales(applied);
    listOrders.mockResolvedValue(page([storeOrder(2, { clientOrderId: pending.id }), storeOrder(1)]));
    view.rerender(<><OrdersScreen /><PortalHost /></>);
    await settle();
    expect(listOrders).toHaveBeenCalledTimes(2);
    expect(listOrders).toHaveBeenLastCalledWith(context, { page: 1, perPage: 25 });
    expect(openButtons()).toEqual([`Open order ${orderReference(applied)}`, 'Open order #1001']);
    expect(cell(pending.id, 'status')).toBe('Completed');
  });

  it('Load more appends page 2, with the store\'s count', async () => {
    const all = Array.from({ length: 40 }, (_, i) => storeOrder(40 - i, { placedAt: '2026-11-24T09:00:00.000Z' }));
    listOrders.mockResolvedValueOnce(page(all.slice(0, 25), { hasMore: true, total: 40 }))
      .mockResolvedValueOnce(page(all.slice(25), { total: 40 }));
    await mount();
    expect(screen.getByTestId('orders-count').textContent).toBe('Showing 25 of 40');
    fireEvent.click(screen.getByTestId('orders-load-more'));
    await settle();
    expect(listOrders).toHaveBeenLastCalledWith(context, { page: 2, perPage: 25 });
    expect(openButtons()).toHaveLength(40);
    expect(openButtons()[25]).toBe('Open order #1015');
    expect(screen.getByTestId('orders-count').textContent).toBe('Showing 40 of 40');
    expect(screen.queryByTestId('orders-load-more')).toBeNull();
  });

  it('a search is sent once the cashier stops typing, and a slow older answer never replaces a newer one', async () => {
    const answers: Record<string, (value: StoreOrderPage) => void> = {};
    listOrders.mockImplementation((_context, query: { search?: string }) => query.search
      ? new Promise((resolve) => { answers[query.search!] = resolve; }) : Promise.resolve(page([])));
    await mount();
    const type = (value: string) => fireEvent.change(screen.getByTestId('orders-search'), { target: { value } });
    type('a');
    type('ad');
    type('ada');
    await act(async () => { await vi.advanceTimersByTimeAsync(249); });
    expect(listOrders).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(listOrders).toHaveBeenCalledTimes(2);
    expect(listOrders).toHaveBeenLastCalledWith(context, { page: 1, perPage: 25, search: 'ada' });
    type('adam');
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(listOrders).toHaveBeenCalledTimes(3);
    await act(async () => { answers.adam!(page([storeOrder(2)])); });
    await act(async () => { answers.ada!(page([storeOrder(1)])); });
    expect(openButtons()).toEqual(['Open order #1002']);
  });

  it('a status filter is sent to the store, and the bar has no payment-method field', async () => {
    await mount();
    expect(screen.queryByTestId('order-filter-payment-method')).toBeNull();
    fireEvent.click(screen.getByTestId('order-filter-status'));
    fireEvent.click(screen.getByTestId('order-filter-status-pending'));
    await settle();
    expect(listOrders).toHaveBeenLastCalledWith(context, { page: 1, perPage: 25, status: 'pending' });
  });

  it('a connector advertising paymentMethod gets the Payment Method field', async () => {
    connector.orderFilters = ['status', 'paymentMethod', 'customerId', 'dateRange'];
    await mount();
    expect(screen.getByTestId('order-filter-payment-method')).toBeTruthy();
  });

  it('plugin contract 3: the Register pill lists this till\'s sales and hides another till\'s', async () => {
    const capabilities = { orderCreate: 1, pluginContract: 3 };
    sessionState.session = { ...sessionState.session!, capabilities };
    const mine = { ...sale('Red hat', 'pending'), registerId: 'till-a' };
    const theirs = { ...sale('Green hat', 'pending'), registerId: 'till-b' };
    withSales(mine, theirs);
    // The store answers the register query with this till's order only.
    listOrders.mockImplementation((_context, query: { registerId?: string }) => Promise.resolve(page(
      query.registerId === undefined ? [storeOrder(2), storeOrder(1)] : query.registerId === 'till-a' ? [storeOrder(2)] : [])));
    await mount();
    expect(openButtons()).toHaveLength(4);
    fireEvent.click(screen.getByTestId('order-filter-register'));
    const menu = screen.getByTestId('order-filter-register-menu');
    expect(Array.from(menu.querySelectorAll('[data-testid^="order-filter-register-"]'), (item) => item.getAttribute('data-testid')))
      .toEqual(['order-filter-register-till-a']);
    expect(screen.getByTestId('order-filter-register-till-a').textContent).toBe('This till');
    fireEvent.click(screen.getByTestId('order-filter-register-till-a'));
    await settle();
    expect(listOrders).toHaveBeenLastCalledWith({ ...context, capabilities }, { page: 1, perPage: 25, registerId: 'till-a' });
    expect(openButtons()).toEqual([`Open order ${orderReference(mine)}`, 'Open order #1002']);
    expect(screen.queryByTestId(`orders-row-${theirs.id}`)).toBeNull();
  });

  it('the Register pill\'s one option is labelled with the till name from Settings', async () => {
    sessionState.session = { ...sessionState.session!, capabilities: { orderCreate: 1, pluginContract: 3 } };
    saveTillName(localStorage, 'https://store.test', 'Front counter');
    await mount();
    fireEvent.click(screen.getByTestId('order-filter-register'));
    expect(screen.getByTestId('order-filter-register-till-a').textContent).toBe('Front counter');
  });

  it('plugin contract 3: a 1-6 digit search without a register filter keeps the old /admin/orders path', async () => {
    sessionState.session = { ...sessionState.session!, capabilities: { orderCreate: 1, pluginContract: 3 } };
    await mount();
    fireEvent.change(screen.getByTestId('orders-search'), { target: { value: '1042' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(listOrders).toHaveBeenLastCalledWith(context, { page: 1, perPage: 25, search: '1042' });
    // No capabilities in the context: listOrders sends the search to /admin/orders, as before contract 3.
    expect(listOrders.mock.lastCall![0]).not.toHaveProperty('capabilities');
  });

  it('below plugin contract 3 there is no Register pill', async () => {
    for (const capabilities of [{ orderCreate: 1, pluginContract: 2 }, { orderCreate: 1 }]) {
      sessionState.session = { ...sessionState.session!, capabilities };
      const view = await mount();
      expect(screen.getByTestId('order-filter-status')).toBeTruthy();
      expect(screen.queryByTestId('order-filter-register')).toBeNull();
      view.unmount();
    }
  });

  it('opens an order only the store has in its own read-only sheet, and the till\'s own sale in the till\'s sheet', async () => {
    const mine = sale('Red hat', 'applied');
    withSales(mine);
    listOrders.mockResolvedValue(page([storeOrder(9, { clientOrderId: mine.id }), storeOrder(3, { totalMinor: 4200 })]));
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Open order #1003' }));
    await settle();
    const sheet = within(screen.getByTestId('store-order-detail-sheet'));
    expect(sheet.getAllByText(formatMoney({ amount: 4200, currency: 'EUR' })!).length).toBeGreaterThan(0);
    expect(sheet.getByText('Card reader')).toBeTruthy();
    expect(sheet.queryByText('Receipt')).toBeNull();
    fireEvent.click(sheet.getByTestId('store-order-close'));
    await settle();
    expect(screen.queryByTestId('store-order-detail-sheet')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: `Open order ${orderReference(mine)}` }));
    await settle();
    expect(screen.getByTestId('order-detail-sheet')).toBeTruthy();
    expect(screen.queryByTestId('store-order-detail-sheet')).toBeNull();
  });
});

// v2's Re-open (row 10.3), Medusa's way: a new sale with the order's lines, started by the Sale screen (lib/reopen-order.ts).
describe('Reopen a store order (row 10.3)', () => {
  const sheet = (onReopen?: (order: StoreOrder) => void) => render(<><StoreOrderDetailSheet order={storeOrder(4)}
    onClose={vi.fn()} formatDate={formatDate} onReopen={onReopen} /><PortalHost /></>);

  it('shows Reopen and hands it the order', async () => {
    const onReopen = vi.fn();
    sheet(onReopen);
    await settle();
    fireEvent.click(within(screen.getByTestId('store-order-detail-sheet')).getByRole('button', { name: 'Re-open' }));
    expect(onReopen).toHaveBeenCalledWith(storeOrder(4));
  });

  it('has no Reopen without onReopen', async () => {
    sheet();
    await settle();
    expect(screen.getByTestId('store-order-detail-sheet')).toBeTruthy();
    expect(screen.queryByTestId('order-detail-reopen')).toBeNull();
    expect(screen.queryByText('Re-open')).toBeNull();
  });

  it('Reopen on a store order closes the sheet and asks the Sale screen to reopen it', async () => {
    const placed = storeOrder(3);
    listOrders.mockResolvedValue(page([placed]));
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Open order #1003' }));
    await settle();
    fireEvent.click(within(screen.getByTestId('store-order-detail-sheet')).getByRole('button', { name: 'Re-open' }));
    await settle();
    expect(screen.queryByTestId('store-order-detail-sheet')).toBeNull();
    expect(vi.mocked(router.dismissTo)).toHaveBeenCalledWith('/');
    expect(takeReopen(sessionState.session!.baseUrl)).toEqual(placed);
    expect(takeReopen(sessionState.session!.baseUrl)).toBeNull();
  });
});

describe('Orders states', () => {
  it('shows Loading orders… under the till\'s unsent sales while the first page is on its way', async () => {
    const pending = sale('Red hat', 'pending');
    withSales(pending);
    listOrders.mockReturnValue(new Promise(() => {}));
    await mount();
    expect(screen.getByTestId('orders-loading').textContent).toBe(ORDERS_LOADING_TEXT);
    expect(screen.getByTestId(`orders-row-${pending.id}`)).toBeTruthy();
    expect(screen.queryByTestId('orders-empty')).toBeNull();
  });

  it('reads No orders yet. for an empty store, and No orders match. for an empty search', async () => {
    await mount();
    expect(screen.getByTestId('orders-empty').textContent).toBe(ORDERS_EMPTY_TEXT);
    fireEvent.change(screen.getByTestId('orders-search'), { target: { value: 'nobody' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(screen.getByTestId('orders-empty').textContent).toBe(ORDERS_NO_MATCH_TEXT);
  });

  it('offline, the table is every sale this till holds, under a muted alert; Retry asks the store again', async () => {
    const synced = sale('Blue shirt', 'applied');
    withSales(synced);
    listOrders.mockRejectedValueOnce(new CustomerServiceError('network', 'offline'));
    await mount();
    expect(screen.getByRole('alert').textContent).toBe(ORDERS_OFFLINE_TEXT);
    expect(screen.getByTestId(`orders-row-${synced.id}`)).toBeTruthy();
    expect(screen.queryByTestId('orders-empty')).toBeNull();
    listOrders.mockResolvedValueOnce(page([storeOrder(1)]));
    fireEvent.click(screen.getByTestId('orders-retry'));
    await settle();
    expect(listOrders).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByTestId('orders-row-order_1')).toBeTruthy();
    expect(screen.queryByTestId(`orders-row-${synced.id}`)).toBeNull();
  });

  it('any other failure shows the till\'s sales under its own line', async () => {
    const synced = sale('Blue shirt', 'applied');
    withSales(synced);
    listOrders.mockRejectedValue(new CustomerServiceError('server', 'boom', { status: 500 }));
    await mount();
    expect(screen.getByRole('alert').textContent).toBe(ORDERS_FAILED_TEXT);
    expect(screen.getByTestId(`orders-row-${synced.id}`)).toBeTruthy();
  });

  it('a refused session is reported to sign the till out, and nothing else is shown', async () => {
    listOrders.mockRejectedValue(new ConnectorUnauthorizedError('expired', 401));
    await mount();
    expect(sessionState.reportUnauthorized).toHaveBeenCalledExactlyOnceWith();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByTestId('orders-retry')).toBeNull();
  });

  it('counts the orders the store could not read', async () => {
    listOrders.mockResolvedValue(page([storeOrder(1)], { unreadable: 2 }));
    await mount();
    expect(screen.getByTestId('orders-unreadable').textContent).toBe("2 orders couldn't be read.");
  });

  it('redirects to /login without a session', async () => {
    sessionState.session = null;
    await mount();
    expect(screen.getByText('redirect:/login')).toBeTruthy();
    expect(listOrders).not.toHaveBeenCalled();
  });
});

describe('Billing Address column and day headers (row 10.1)', () => {
  const at = (...parts: [number, number, number, number, number]) => new Date(...parts).toISOString();
  const table = () => screen.getByTestId('orders-table');
  // The day headers and rows of the main table, in screen order.
  const layout = (keys: string[]) => Array.from(table().querySelectorAll('[data-testid^="orders-row-"]'),
    (element) => element.getAttribute('data-testid')!.replace('orders-row-', ''))
    .filter((id) => id.startsWith('day-') || keys.includes(id));

  it('rows show before the addresses arrive, then fill in; an order without one reads —', async () => {
    const reads = holdBilling();
    listOrders.mockResolvedValue(page([storeOrder(2), storeOrder(1)]));
    await mount();
    expect(within(table()).getByText('Billing Address', { exact: true })).toBeTruthy();
    expect(openButtons()).toEqual(['Open order #1002', 'Open order #1001']);
    expect(cell('order_2', 'billing')).toBe('');
    expect(cell('order_1', 'billing')).toBe('');
    expect(billingFetch).toHaveBeenCalledOnce();
    expect(billingFetch.mock.calls[0]![0]).toContain('/admin/orders?id[]=order_2&id[]=order_1&limit=2&fields=id,billing_address.');
    expect(billingFetch.mock.calls[0]![1]).toMatchObject({ headers: { Authorization: 'Bearer t' } });
    await act(async () => { reads[0]!(billingAnswer([address('order_2', 'Nørregade 1'), { id: 'order_1', billing_address: null }])); });
    await settle();
    expect(cell('order_2', 'billing')).toBe('Nørregade 1, Copenhagen, DK');
    expect(cell('order_1', 'billing')).toBe('—');
  });

  it('a till\'s sale with its own stored address shows it; one without shows its store order\'s', async () => {
    const own = { ...sale('Red hat', 'applied'), customer: { id: 'c1', name: 'Ada', billing: { address1: 'Main St 5', city: 'Berlin', country: 'DE' } } };
    const plain = sale('Blue shirt', 'applied');
    withSales(own, plain);
    listOrders.mockResolvedValue(page([storeOrder(9, { clientOrderId: own.id }), storeOrder(8, { clientOrderId: plain.id })]));
    billingFetch.mockImplementation(async () => billingAnswer([address('order_9', 'Shop St 1'), address('order_8', 'Shop St 1')]));
    await mount();
    await settle();
    expect(cell(own.id, 'billing')).toBe('Main St 5, Berlin, DE');
    expect(cell(plain.id, 'billing')).toBe('Shop St 1, Copenhagen, DK');
  });

  it.each([
    ['a failed read', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['a server error', async () => billingAnswer([], 500)],
    ['a 403', async () => billingAnswer([], 403)],
  ])('%s leaves the list whole with empty cells, no alert and no second read', async (_, outcome) => {
    billingFetch.mockImplementation(outcome);
    listOrders.mockResolvedValue(page([storeOrder(2), storeOrder(1)]));
    await mount();
    await settle();
    expect(openButtons()).toEqual(['Open order #1002', 'Open order #1001']);
    expect(cell('order_2', 'billing')).toBe('');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(sessionState.reportUnauthorized).not.toHaveBeenCalled();
    expect(billingFetch).toHaveBeenCalledOnce();
  });

  it('a 401 on the read reports the refused session', async () => {
    billingFetch.mockImplementation(async () => billingAnswer([], 401));
    listOrders.mockResolvedValue(page([storeOrder(1)]));
    await mount();
    await settle();
    expect(sessionState.reportUnauthorized).toHaveBeenCalledExactlyOnceWith();
  });

  it('Load more while page 1\'s addresses are out still fills page 1, and page 2', async () => {
    const reads = holdBilling();
    const all = Array.from({ length: 30 }, (_, i) => storeOrder(30 - i, { placedAt: '2026-11-24T09:00:00.000Z' }));
    listOrders.mockResolvedValueOnce(page(all.slice(0, 25), { hasMore: true, total: 30 })).mockResolvedValueOnce(page(all.slice(25), { total: 30 }));
    await mount();
    fireEvent.click(screen.getByTestId('orders-load-more'));
    await settle();
    expect(billingFetch).toHaveBeenCalledTimes(2);
    expect(billingFetch.mock.calls[1]![0]).toContain('id[]=order_5&id[]=order_4&id[]=order_3&id[]=order_2&id[]=order_1&limit=5&');
    await act(async () => { reads[1]!(billingAnswer([address('order_1', 'Page Two 2')])); });
    await settle();
    await act(async () => { reads[0]!(billingAnswer([address('order_30', 'Page One 1')])); });
    await settle();
    expect(cell('order_30', 'billing')).toBe('Page One 1, Copenhagen, DK');
    expect(cell('order_1', 'billing')).toBe('Page Two 2, Copenhagen, DK');
  });

  it('an earlier read answering late does not replace a later read\'s address', async () => {
    const reads = holdBilling();
    listOrders.mockResolvedValue(page([storeOrder(1)]));
    await mount();
    fireEvent.change(screen.getByTestId('orders-search'), { target: { value: 'ada' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(billingFetch).toHaveBeenCalledTimes(2);
    await act(async () => { reads[1]!(billingAnswer([address('order_1', 'New St 2')])); });
    await settle();
    expect(cell('order_1', 'billing')).toBe('New St 2, Copenhagen, DK');
    await act(async () => { reads[0]!(billingAnswer([address('order_1', 'Old St 1')])); });
    await settle();
    expect(cell('order_1', 'billing')).toBe('New St 2, Copenhagen, DK');
  });

  it('a change of token empties the addresses and drops an answer read with the old one', async () => {
    const reads = holdBilling();
    listOrders.mockResolvedValue(page([storeOrder(1)]));
    billingFetch.mockImplementationOnce(async () => billingAnswer([address('order_1', 'Old St 1')]));
    const view = await mount();
    await settle();
    expect(cell('order_1', 'billing')).toBe('Old St 1, Copenhagen, DK');
    // A second read under the old token is still out when the token changes.
    fireEvent.change(screen.getByTestId('orders-search'), { target: { value: 'ada' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    sessionState.session = { ...sessionState.session!, token: 'u' };
    view.rerender(<><OrdersScreen /><PortalHost /></>);
    await settle();
    expect(cell('order_1', 'billing')).toBe('');
    expect(reads).toHaveLength(2);
    await act(async () => { reads[0]!(billingAnswer([address('order_1', 'Stale St 3')])); });
    await settle();
    expect(cell('order_1', 'billing')).toBe('');
    await act(async () => { reads[1]!(billingAnswer([address('order_1', 'New St 2')])); });
    await settle();
    expect(cell('order_1', 'billing')).toBe('New St 2, Copenhagen, DK');
  });

  it('an old token\'s read answering after the new token\'s does not replace its address', async () => {
    const reads = holdBilling();
    listOrders.mockResolvedValue(page([storeOrder(1)]));
    const view = await mount();
    sessionState.session = { ...sessionState.session!, token: 'u' };
    view.rerender(<><OrdersScreen /><PortalHost /></>);
    await settle();
    expect(reads).toHaveLength(2);
    await act(async () => { reads[1]!(billingAnswer([address('order_1', 'New St 2')])); });
    await settle();
    expect(cell('order_1', 'billing')).toBe('New St 2, Copenhagen, DK');
    await act(async () => { reads[0]!(billingAnswer([address('order_1', 'Stale St 3')])); });
    await settle();
    expect(cell('order_1', 'billing')).toBe('New St 2, Copenhagen, DK');
  });

  it('a 401 on an old token\'s read does not report the new session, whose read still fills the cell', async () => {
    const reads = holdBilling();
    listOrders.mockResolvedValue(page([storeOrder(1)]));
    const view = await mount();
    sessionState.session = { ...sessionState.session!, token: 'u' };
    view.rerender(<><OrdersScreen /><PortalHost /></>);
    await settle();
    expect(reads).toHaveLength(2);
    await act(async () => { reads[0]!(billingAnswer([], 401)); });
    await settle();
    expect(sessionState.reportUnauthorized).not.toHaveBeenCalled();
    await act(async () => { reads[1]!(billingAnswer([address('order_1', 'New St 2')])); });
    await settle();
    expect(cell('order_1', 'billing')).toBe('New St 2, Copenhagen, DK');
    expect(sessionState.reportUnauthorized).not.toHaveBeenCalled();
  });

  it('one Today and one Yesterday header, each above its own rows; an unsent sale of today first in its day', async () => {
    vi.setSystemTime(new Date(2026, 10, 25, 15, 0));
    const pending = sale('Red hat', 'pending', at(2026, 10, 25, 14, 0));
    withSales(pending);
    listOrders.mockResolvedValue(page([storeOrder(4, { placedAt: at(2026, 10, 25, 9, 0) }), storeOrder(3, { placedAt: at(2026, 10, 25, 8, 0) }),
      storeOrder(2, { placedAt: at(2026, 10, 24, 18, 0) }), storeOrder(1, { placedAt: at(2026, 10, 24, 9, 0) })]));
    await mount();
    expect(layout([pending.id, 'order_4', 'order_3', 'order_2', 'order_1'])).toEqual(
      ['day-2026-11-25', pending.id, 'order_4', 'order_3', 'day-2026-11-24', 'order_2', 'order_1']);
    const today = screen.getByTestId('orders-row-day-2026-11-25');
    expect(within(today).getByRole('heading').textContent).toBe('Today');
    expect(within(screen.getByTestId('orders-row-day-2026-11-24')).getByRole('heading').textContent).toBe('Yesterday');
    expect(within(today).queryByRole('button')).toBeNull();
    expect(screen.getAllByText('Today', { exact: true })).toHaveLength(1);
    expect(screen.getAllByText('Yesterday', { exact: true })).toHaveLength(1);
  });

  it('the offline list has day headers, and its rows read — without an address of their own', async () => {
    vi.setSystemTime(new Date(2026, 10, 25, 15, 0));
    const today = sale('Red hat', 'applied', at(2026, 10, 25, 10, 0));
    const older = sale('Blue shirt', 'applied', at(2026, 10, 20, 10, 0));
    withSales(today, older);
    listOrders.mockRejectedValue(new CustomerServiceError('network', 'offline'));
    await mount();
    expect(screen.getByRole('alert').textContent).toBe(ORDERS_OFFLINE_TEXT);
    expect(layout([today.id, older.id])).toEqual(['day-2026-11-25', today.id, 'day-2026-11-20', older.id]);
    expect(within(screen.getByTestId('orders-row-day-2026-11-20')).getByRole('heading').textContent)
      .toBe(new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(2026, 10, 20, 10, 0)));
    expect(cell(today.id, 'billing')).toBe('—');
    expect(billingFetch).not.toHaveBeenCalled();
  });

  it('Needs attention has the Billing Address column and day headers', async () => {
    const refused = { ...sale('Red hat', 'rejected'), error: { code: 'platform_error', message: 'Refused' } };
    withSales(refused);
    await mount();
    const attention = screen.getByTestId('orders-attention');
    expect(within(attention).getByText('Billing Address', { exact: true })).toBeTruthy();
    expect(screen.getByTestId(`orders-attention-row-${refused.id}-billing`).textContent).toBe('—');
    expect(attention.querySelector('[data-testid^="orders-attention-row-day-"]')).not.toBeNull();
    expect(within(attention).getByRole('heading')).toBeTruthy();
  });

  it('the Billing Address head and its cells take the same double width', async () => {
    listOrders.mockResolvedValue(page([storeOrder(1)]));
    await mount();
    const head = within(table()).getByText('Billing Address', { exact: true }).closest('[role="columnheader"]');
    expect(head?.getAttribute('data-class')).toBe('flex-[2]');
    expect(screen.getByTestId('orders-row-order_1-billing').getAttribute('data-class')).toBe(head?.getAttribute('data-class'));
  });
});

describe('orders on a phone (row 10.5)', () => {
  it('on a phone a store order\'s detail shows its Billing Address', async () => {
    setWindowWidth(390, 844);
    listOrders.mockResolvedValue(page([storeOrder(2)]));
    billingFetch.mockImplementation(async () => billingAnswer([address('order_2', 'Nørregade 1')]));
    await mount();
    await settle();
    const row = screen.getByTestId('orders-row-order_2');
    expect(screen.queryByTestId('orders-row-order_2-billing')).toBeNull();
    fireEvent.click(within(row).getByRole('button', { name: 'Open order #1002' }));
    await settle();
    const sheet = within(screen.getByTestId('store-order-detail-sheet'));
    expect(sheet.getByTestId('store-order-detail-billing').textContent).toBe('Billing addressNørregade 1, Copenhagen, DK');
  });
});
