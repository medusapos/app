// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { PortalHost } from '@tallyui/primitives';
import type { ReactElement } from 'react';
import type { OutboxState, PosOrder } from '@tallyui/pos';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ProductsScreen from '../app/index';
import { openOrderStore } from '../lib/order-store';
import { useOutboxContext } from '../lib/outbox-context';
import { useRegister } from '../lib/register-context';
import { useSession } from '../lib/session-context';
import { sessionFixture } from './session-fixture';
import { fetchStoreSettings } from '../lib/store-settings';
import { useReplicatedProducts, type SyncState } from '../lib/use-replicated-products';
import { capabilities, storeSettings } from './pos-connector-mock';
import { openRegisterFixture } from './register-fixture';
import { setWindowWidth } from './window-width';
import { takeLeg } from './tender-pane';

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
let outbox: ReturnType<typeof useOutboxContext>;
let replicated: ReturnType<typeof useReplicatedProducts>;
const screenTree = () => <><ProductsScreen /><PortalHost /></>;
let rerender: (ui: ReactElement) => void;

beforeEach(async () => {
  setWindowWidth(1280);
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  });
  const session = { baseUrl: `https://awaiting-${crypto.randomUUID()}.test`, email: 'admin@store.test', token: 'jwt',
    capabilities: { orderCreate: 4, taxRounding: { granularity: 'per_order' as const, mode: 'half_away_from_zero' as const } } };
  vi.mocked(useSession).mockReturnValue(sessionFixture(session));
  capabilities.mockResolvedValue(session.capabilities);
  storeSettings.mockResolvedValue({ currency: 'EUR', pricesIncludeTax: false, taxRatesPpm: { default: 250000 },
    pricingContext: { region_id: 'reg_eu', currency_code: 'eur', publishable_key: 'pk_1' } });
  vi.mocked(fetchStoreSettings).mockResolvedValue({ storeName: 'Test shop', currency: 'EUR',
    location: { id: 'loc', name: 'Main', countryCode: 'dk' } });
  vi.mocked(useRegister).mockReturnValue(openRegisterFixture());
  replicated = { products: [{ id: 'shirt', title: 'Shirt', status: 'published',
    variants: [{ id: 'blue', title: 'Blue', sku: 'BLUE', prices: [{ amount: 19.2, currency_code: 'eur' }] }] }],
    state: 'synced', error: null, lastSyncedAt: null, stockOverlay: undefined, lastStockCheckAt: null,
    reconcileStock: vi.fn(async () => {}), pullNotice: undefined, resumePull: vi.fn(), syncNow: vi.fn(), clearAndRefresh: vi.fn(), unlisted: undefined };
  vi.mocked(useReplicatedProducts).mockReturnValue(replicated);
  store = await openOrderStore(session.baseUrl);
  record.mockReset().mockResolvedValue(undefined);
  outbox = { orders: store.orders, record, state: { pending: 0, sending: false },
    recent: [], savesInFlight: 0, stuckCommandIds: [], flush: vi.fn(), requeue: vi.fn(), discard: vi.fn(), cancelOnStore: vi.fn(), payRestOnStore: vi.fn(), reverseOnStore: vi.fn(), isStored: vi.fn(async () => true) };
  vi.mocked(useOutboxContext).mockReturnValue(outbox);
});
afterEach(async () => {
  cleanup();
  await store.close();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/** The catalogue's sync state, which drives the screen's `online` ('offline' is offline). */
function syncState(state: SyncState) {
  vi.mocked(useReplicatedProducts).mockReturnValue({ ...replicated, state });
}
async function startTender() {
  await act(async () => { ({ rerender } = render(screenTree())); });
  await screen.findByTestId('product-tile-Shirt');
  fireEvent.click(screen.getByTestId('product-tile-Shirt'));
  if (document.documentElement.clientWidth < 600) fireEvent.click(screen.getByRole('tab', { name: /^Cart, / }));
  await act(async () => { fireEvent.click(screen.getByTestId('cart-checkout')); });
}
async function complete(): Promise<PosOrder> {
  await act(async () => { fireEvent.click(screen.getByTestId('tender-complete')); });
  await screen.findByRole('button', { name: 'New sale' });
  expect(record).toHaveBeenCalledOnce();
  return record.mock.calls[0][0];
}
/** Moves the paid sale's outbox entry (and the outbox state) and rerenders the screen. */
async function outboxNow(order: PosOrder, syncStatus: PosOrder['syncStatus'], state: Partial<OutboxState> = {}) {
  vi.mocked(useOutboxContext).mockReturnValue({ ...outbox, recent: [{ ...order, syncStatus }],
    state: { pending: syncStatus === 'pending' ? 1 : 0, sending: false, ...state } });
  await act(async () => { rerender(screenTree()); });
}
const status = () => screen.getByTestId('paid-awaiting-status').textContent;

// The keypad tender pane's steps exceed the 5 s default on CI runners.
it('leads an offline exact cash sale with "Awaiting store", then the normal paid screen once the store has it', async () => {
  syncState('offline');
  await startTender();
  takeLeg('cash', '24.00');
  const order = await complete();
  await outboxNow(order, 'pending');
  expect(screen.getByTestId('paid-awaiting-figure').textContent).toBe('Paid €24.00');
  expect(status()).toBe('Awaiting store · Cash');
  expect(screen.getByTestId('paid-awaiting-clock')).toBeTruthy();
  expect(screen.getByText('Awaiting store')).toBeTruthy();
  expect(screen.queryByTestId('paid-change-due')).toBeNull();
  syncState('synced');
  await outboxNow(order, 'applied');
  expect(screen.queryByTestId('paid-awaiting')).toBeNull();
  expect(screen.queryByTestId('paid-change-due')).toBeNull();
}, 15000);

// The keypad tender pane's steps exceed the 5 s default on CI runners.
it('keeps the change as the headline while awaiting, and hands back to the sent change headline', async () => {
  syncState('offline');
  await startTender();
  takeLeg('cash', '30.00');
  const order = await complete();
  await outboxNow(order, 'pending');
  expect(screen.getByTestId('paid-awaiting-figure').textContent).toBe('Change €6.00');
  expect(status()).toBe('Awaiting store · Paid €24.00 · tendered €30.00 in cash');
  expect(screen.queryByTestId('paid-change-due')).toBeNull();
  syncState('synced');
  await outboxNow(order, 'applied');
  expect(screen.queryByTestId('paid-awaiting')).toBeNull();
  expect(screen.getByTestId('paid-change-figure').textContent).toBe('Change €6.00');
}, 15000);

// The keypad tender pane's steps exceed the 5 s default on CI runners.
it('online, shows it only after a send failed, and holds it through the retry until the store has the sale', async () => {
  await startTender();
  takeLeg('cash', '24.00');
  const order = await complete();
  await outboxNow(order, 'pending');
  expect(screen.queryByTestId('paid-awaiting')).toBeNull();
  await outboxNow(order, 'pending', { nextAttemptAt: Date.now() + 5000, lastRetryReason: 'network' });
  expect(screen.getByTestId('paid-awaiting')).toBeTruthy();
  await outboxNow(order, 'pending', { sending: true });
  expect(screen.getByTestId('paid-awaiting')).toBeTruthy();
  await outboxNow(order, 'applied');
  expect(screen.queryByTestId('paid-awaiting')).toBeNull();
}, 15000);

// The keypad tender pane's steps exceed the 5 s default on CI runners.
it('shows it on a phone too', async () => {
  setWindowWidth(390);
  syncState('offline');
  await startTender();
  takeLeg('cash', '24.00');
  const order = await complete();
  await outboxNow(order, 'pending');
  expect(status()).toBe('Awaiting store · Cash');
}, 15000);

// The keypad tender pane's steps exceed the 5 s default on CI runners.
it('names a card terminal part and a cash part in payment order', async () => {
  syncState('offline');
  await startTender();
  takeLeg('external', '10.00');
  takeLeg('cash', '14.00');
  const order = await complete();
  await outboxNow(order, 'pending');
  expect(status()).toBe('Awaiting store · Card terminal + Cash · 2 payments');
}, 15000);

// The keypad tender pane's steps exceed the 5 s default on CI runners.
it('names a method once when two payments use it, then counts the payments', async () => {
  syncState('offline');
  await startTender();
  takeLeg('external', '10.00');
  takeLeg('external', '14.00');
  const order = await complete();
  await outboxNow(order, 'pending');
  expect(status()).toBe('Awaiting store · Card terminal · 2 payments');
}, 15000);

// The keypad tender pane's steps exceed the 5 s default on CI runners.
it('keeps the change as the headline and counts the payments when two cash payments over-tender', async () => {
  syncState('offline');
  await startTender();
  takeLeg('cash', '10.00');
  takeLeg('cash', '20.00');
  const order = await complete();
  await outboxNow(order, 'pending');
  expect(screen.getByTestId('paid-awaiting-figure').textContent).toBe('Change €6.00');
  expect(status()).toBe('Awaiting store · Paid €24.00 · tendered €30.00 in cash · 2 payments');
}, 15000);

// The keypad tender pane's steps exceed the 5 s default on CI runners.
it('the paid summary marks an awaiting cash payment Captured and Recorded offline, and drops Recorded offline once sent', async () => {
  syncState('offline');
  await startTender();
  takeLeg('cash', '24.00');
  const order = await complete();
  await outboxNow(order, 'pending');
  const id = order.payments[0].id;
  const row = within(screen.getByTestId('paid-summary')).getByTestId(`summary-payment-${id}`);
  expect(within(row).getByTestId(`summary-payment-${id}-status`).textContent).toBe('Captured');
  const offline = within(row).getByTestId(`summary-recorded-offline-${id}`);
  expect(offline.textContent).toBe('Recorded offline');
  const tendered = within(row).getByTestId(`summary-payment-${id}-tendered`);
  expect(tendered.compareDocumentPosition(offline) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  syncState('synced');
  await outboxNow(order, 'applied');
  expect(screen.queryByTestId(`summary-recorded-offline-${id}`)).toBeNull();
  expect(screen.getByTestId(`summary-payment-${id}-status`).textContent).toBe('Captured');
}, 15000);

// The keypad tender pane's steps exceed the 5 s default on CI runners.
it('marks each payment of an awaiting split sale Recorded offline', async () => {
  syncState('offline');
  await startTender();
  takeLeg('external', '10.00');
  takeLeg('cash', '14.00');
  const order = await complete();
  await outboxNow(order, 'pending');
  const summary = within(screen.getByTestId('paid-summary'));
  expect(order.payments).toHaveLength(2);
  for (const { id } of order.payments) {
    expect(summary.getByTestId(`summary-payment-${id}-status`).textContent).toBe('Captured');
    expect(summary.getByTestId(`summary-recorded-offline-${id}`).textContent).toBe('Recorded offline');
  }
}, 15000);

it("the paid receipt and summary gain the store's display number once the store applies the sale", async () => {
  await startTender();
  takeLeg('cash', '24.00');
  const order = await complete();
  const shortId = order.id.slice(-8);
  await outboxNow(order, 'pending');
  expect(screen.getByTestId('receipt-order').textContent).toBe(`Order ${shortId}`);
  await outboxNow({ ...order, serverRefs: { orderId: 'order_1', displayId: '42', totalMinor: order.totalMinor } }, 'applied');
  const reference = `${shortId} · #42`;
  expect(screen.getByTestId('receipt-order').textContent).toBe(`Order ${reference}`);
  expect(within(screen.getByTestId('paid-summary')).getByText(reference, { exact: false })).toBeTruthy();
}, 15000);

it('before the outbox has the sale, the paid screen still shows the snapshot', async () => {
  await startTender();
  takeLeg('cash', '24.00');
  const order = await complete();
  expect(screen.getByTestId('receipt-order').textContent).toBe(`Order ${order.id.slice(-8)}`);
}, 15000);
