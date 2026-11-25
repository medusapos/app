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
import { sessionFixture } from './session-fixture';
import { fetchStoreSettings } from '../lib/store-settings';
import { useReplicatedProducts } from '../lib/use-replicated-products';
import { capabilities, storeSettings } from './pos-connector-mock';
import { openRegisterFixture } from './register-fixture';
import { setWindowWidth } from './window-width';
import { takeLeg, tenderPane } from './tender-pane';

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
const add = () => fireEvent.click(screen.getByTestId('product-tile-Shirt'));
beforeEach(async () => {
  setWindowWidth(1280);
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  });
  const session = { baseUrl: `https://split-${crypto.randomUUID()}.test`, email: 'admin@store.test', token: 'jwt',
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
    reconcileStock: vi.fn(async () => {}), pullNotice: undefined, resumePull: vi.fn(), syncNow: vi.fn(), clearAndRefresh: vi.fn(), unlisted: undefined });
  store = await openOrderStore(session.baseUrl);
  record.mockReset().mockResolvedValue(undefined);
  vi.mocked(useOutboxContext).mockReturnValue({ orders: store.orders, record, state: { pending: 0, sending: false },
    recent: [], savesInFlight: 0, stuckCommandIds: [], flush: vi.fn(), requeue: vi.fn(), discard: vi.fn(), isStored: vi.fn(async () => true) });
});
afterEach(async () => {
  cleanup();
  await store.close();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("at 1280 the tender takes the catalogue's side and a read-only order summary stays beside it", async () => {
  await act(async () => { render(<><ProductsScreen /><PortalHost /></>); });
  await screen.findByTestId('product-tile-Shirt');
  add();
  await act(async () => { fireEvent.click(screen.getByTestId('cart-checkout')); });
  const slot = screen.getByTestId('tender-slot');
  const summary = screen.getByTestId('tender-order-summary');
  expect(within(slot).getByTestId('tender-pane')).toBeTruthy();
  expect(screen.queryByRole('searchbox')).toBeNull();
  expect(screen.queryByTestId('product-tile-Shirt')).toBeNull();
  const [line] = within(summary).getAllByTestId(/^tender-summary-line-/);
  expect(Array.from(line.children[0].children).map((cell) => cell.textContent))
    .toEqual(['1', 'Shirt', '€19.20', '€19.20']);
  const totals = within(summary).getByTestId('tender-summary-totals');
  expect(totals.textContent).toContain('Total');
  expect(totals.textContent).toContain('€24.00');
  expect(within(summary).getByTestId('tender-summary-customer').textContent).toBe('Customer: Guest');
  expect(within(summary).queryByRole('button')).toBeNull();
  expect(within(summary).queryByTestId('cart-checkout')).toBeNull();
  expect(slot.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it('Back returns the catalogue and the editable cart', async () => {
  await act(async () => { render(<><ProductsScreen /><PortalHost /></>); });
  await screen.findByTestId('product-tile-Shirt');
  add();
  await act(async () => { fireEvent.click(screen.getByTestId('cart-checkout')); });
  fireEvent.click(tenderPane().getByRole('button', { name: 'Back' }));
  expect(screen.getByRole('searchbox')).toBeTruthy();
  expect(screen.getByTestId('product-tile-Shirt')).toBeTruthy();
  expect(screen.queryByTestId('tender-order-summary')).toBeNull();
  expect(screen.getByTestId('cart-checkout')).toBeTruthy();
});

it('with the cart on the left the tender takes the right', async () => {
  await act(async () => { render(<><ProductsScreen /><PortalHost /></>); });
  await screen.findByTestId('product-tile-Shirt');
  fireEvent.click(screen.getByTestId('cart-settings-button'));
  fireEvent.click(screen.getByTestId('cart-settings-side-left'));
  fireEvent.click(screen.getByTestId('cart-settings-close'));
  add();
  await act(async () => { fireEvent.click(screen.getByTestId('cart-checkout')); });
  const panels = screen.getByTestId('till-panels');
  expect(panels.style.flexDirection).toBe('row-reverse');
  expect(within(panels).getByTestId('tender-slot')).toBeTruthy();
  expect(within(panels).getByTestId('tender-order-summary')).toBeTruthy();
});

it('on a phone the tender stays full height with no order summary', async () => {
  setWindowWidth(390);
  await act(async () => { render(<><ProductsScreen /><PortalHost /></>); });
  await screen.findByTestId('product-tile-Shirt');
  add();
  fireEvent.click(screen.getByRole('tab', { name: /^Cart, / }));
  await act(async () => { fireEvent.click(screen.getByTestId('cart-checkout')); });
  expect(screen.getByTestId('tender-pane')).toBeTruthy();
  expect(screen.queryByTestId('tender-order-summary')).toBeNull();
  expect(screen.queryByTestId('tender-slot')).toBeNull();
});

/** The tender summary's payment rows (each `summary-payment-<id>`, not its -status or -tendered parts). */
const summaryRows = () => within(screen.getByTestId('tender-summary-payments')).queryAllByTestId(/^summary-payment-/)
  .filter((row) => !/-(status|tendered)$/.test(row.getAttribute('data-testid')!));
const openTender = async () => {
  await act(async () => { render(<><ProductsScreen /><PortalHost /></>); });
  await screen.findByTestId('product-tile-Shirt');
  add();
  await act(async () => { fireEvent.click(screen.getByTestId('cart-checkout')); });
};

// The keypad tender pane's steps exceed the 5 s default on CI runners.
it('after a cash part payment the tender summary lists it under Payments with Total, Paid and Remaining', async () => {
  await openTender();
  takeLeg('cash', '5.00');
  const summary = within(screen.getByTestId('tender-order-summary'));
  const payments = summary.getByTestId('tender-summary-payments');
  expect(payments.textContent).toContain('Payments');
  const [cash] = summaryRows();
  expect(summaryRows()).toHaveLength(1);
  const cashId = cash.getAttribute('data-testid');
  expect(cash.textContent).toContain('Cash');
  expect(cash.textContent).toContain('€5.00');
  expect(summary.getByTestId(`${cashId}-status`).textContent).toBe('Captured');
  // 5.0.0 stamps tendered and change on a cash leg at Take (pos use-sale.ts:961-993), so an open sale's leg shows them.
  expect(summary.getByTestId(`${cashId}-tendered`).textContent).toBe('Tendered €5.00 · change €0.00');
  expect(summary.getByTestId('summary-total').textContent).toBe('Total€24.00');
  expect(summary.getByTestId('summary-paid').textContent).toBe('Paid€5.00');
  expect(summary.getByTestId('summary-remaining').textContent).toBe('Remaining€19.00');
  expect(summary.queryByTestId('summary-change')).toBeNull();
  // CartTotal's own Total row is hidden, so the payments block carries the only Total.
  expect(summary.getByTestId('tender-summary-totals').textContent!.match(/Total/g)).toHaveLength(1);
  takeLeg('external', '10.00');
  const rows = summaryRows();
  expect(rows).toHaveLength(2);
  const cardId = rows[1].getAttribute('data-testid');
  expect(rows[1].textContent).toContain('Card terminal');
  expect(rows[1].textContent).toContain('€10.00');
  expect(summary.getByTestId(`${cardId}-status`).textContent).toBe('Captured');
  expect(summary.queryByTestId(`${cardId}-tendered`)).toBeNull();
  expect(summary.getByTestId('summary-paid').textContent).toBe('Paid€15.00');
  expect(summary.getByTestId('summary-remaining').textContent).toBe('Remaining€9.00');
}, 15000);

// The keypad tender pane's steps exceed the 5 s default on CI runners.
it('an overpaid cash payment shows Paid at the total, Remaining €0.00 and the Change row', async () => {
  await openTender();
  takeLeg('cash', '30.00');
  const summary = within(screen.getByTestId('tender-order-summary'));
  const rows = summaryRows();
  expect(rows).toHaveLength(1);
  expect(rows[0].textContent).toContain('Cash');
  expect(rows[0].textContent).toContain('€30.00');
  expect(summary.getByTestId(`${rows[0].getAttribute('data-testid')}-status`).textContent).toBe('Captured');
  // 5.0.0 nets a cash leg at Take (pos use-sale.ts:961-993): 24.00 applied, tendered 30.00, change 6.00 on the leg.
  expect(summary.getByTestId(`${rows[0].getAttribute('data-testid')}-tendered`).textContent).toBe('Tendered €30.00 · change €6.00');
  expect(summary.getByTestId('summary-paid').textContent).toBe('Paid€24.00');
  expect(summary.getByTestId('summary-remaining').textContent).toBe('Remaining€0.00');
  expect(summary.getByTestId('summary-change').textContent).toBe('Change€6.00');
}, 15000);

// The keypad tender pane's steps exceed the 5 s default on CI runners.
it('with no payment, or only a cancelled one, the tender summary has no Payments block', async () => {
  await openTender();
  const summary = within(screen.getByTestId('tender-order-summary'));
  expect(summary.queryByTestId('tender-summary-payments')).toBeNull();
  expect(summary.getByTestId('tender-summary-totals').textContent).toContain('Total');
  expect(summary.getByTestId('tender-summary-totals').textContent).toContain('€24.00');
  takeLeg('external', '10.00');
  expect(summary.getByTestId('tender-summary-payments')).toBeTruthy();
  fireEvent.click(screen.getByTestId(/^tender-leg-.*-void$/));
  expect(summary.queryByTestId('tender-summary-payments')).toBeNull();
  expect(summary.getByTestId('tender-summary-totals').textContent).toContain('Total');
}, 15000);
