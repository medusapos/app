// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PortalHost } from '@tallyui/primitives';
import { toOrderCreateEnvelope, type PosOrder } from '@tallyui/pos';
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
import { pickMethod, take, takeLeg, tenderBalance, tenderEntry } from './tender-pane';

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
const add = () => fireEvent.click(screen.getByTestId('product-tile-Shirt'));
const headline = () => screen.getByTestId('tender-headline').textContent;
/** The ledger's payment legs (each row's testID; its status and Cancel payment ids end -status and -void). */
const legs = () => screen.queryAllByTestId(/^tender-leg-/).filter((row) => !/-(status|void)$/.test(row.getAttribute('data-testid')!));
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
    recent: [], savesInFlight: 0, stuckCommandIds: [], flush: vi.fn(), requeue: vi.fn(), isStored: vi.fn(async () => true) });
});
afterEach(async () => {
  cleanup();
  await store.close();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
async function startSplit() {
  await act(async () => { render(<><ProductsScreen /><PortalHost /></>); });
  await screen.findByTestId('product-tile-Shirt');
  add();
  // v2's cart foot: Checkout opens the one tender pane, which takes split legs itself.
  await act(async () => { fireEvent.click(screen.getByTestId('cart-checkout')); });
  expect(headline()).toBe('Total€24.00');
  expect(tenderBalance()).toBe('€24.00');
}
function tender(method: 'card' | 'cash', amount: string) {
  takeLeg(method === 'card' ? 'external' : 'cash', amount);
}
async function complete() {
  await act(async () => { fireEvent.click(screen.getByTestId('tender-complete')); });
  await screen.findByRole('button', { name: 'New sale' });
  expect(record).toHaveBeenCalledOnce();
  const order = record.mock.calls[0][0];
  return toOrderCreateEnvelope(order, 'register-1');
}

// The keypad tender pane's steps exceed the 5 s default on CI runners.
it('takes a card part and a cash remainder, shows change from cash only, and records both payments', async () => {
  await startSplit();
  tender('card', '10.00');
  expect(headline()).toBe('Remaining€14.00€10.00 of €24.00 paid');
  expect(screen.queryByTestId('tender-change')).toBeNull();
  expect(tenderEntry()).toBe('€14.00');
  tender('cash', '20.00');
  expect(tenderBalance()).toBe('€0.00');
  expect(screen.getByTestId('tender-change').textContent).toBe('Change €6.00');
  const command = await complete();
  expect(command.type).toBe('order.create');
  expect(command.payload.totalMinor).toBe(2400);
  expect(command.payload.payments).toEqual([
    expect.objectContaining({ method: 'external', amountMinor: 1000 }),
    expect.objectContaining({ method: 'cash', amountMinor: 1400, tenderedMinor: 2000, changeMinor: 600 }),
  ]);
  expect(screen.getByLabelText('Card terminal: €10.00')).toBeTruthy();
  expect(screen.getByLabelText('Cash tendered: €20.00')).toBeTruthy();
  expect(screen.getByLabelText('Change: €6.00')).toBeTruthy();
  expect(screen.getByTestId('paid-change-figure').textContent).toBe('Change €6.00');
  expect(screen.getByTestId('paid-change-tendered').textContent).toBe('Paid €24.00 · tendered €20.00 in cash');
  expect(screen.getByTestId('paid-change-tick')).toBeTruthy();
}, 15000);

// The keypad tender pane's steps exceed the 5 s default on CI runners.
it('leads a cash sale with change with v2\'s tick, change heading and paid · tendered line', async () => {
  await startSplit();
  tender('cash', '30.00');
  await complete();
  expect(screen.getByTestId('paid-change-figure').textContent).toBe('Change €6.00');
  expect(screen.getByTestId('paid-change-tendered').textContent).toBe('Paid €24.00 · tendered €30.00 in cash');
  expect(screen.getByTestId('paid-change-tick')).toBeTruthy();
  expect(screen.getByTestId('paid-change-due').textContent).not.toContain('Change Due');
}, 15000);

// The keypad tender pane's steps exceed the 5 s default on CI runners.
it('caps a card part at the balance due, with no change from card', async () => {
  await startSplit();
  // The pane caps a card leg before it is taken: over the balance, Take is refused with v2's hint, and nothing is recorded.
  tender('card', '30.00');
  expect(screen.getByTestId('tender-entry-hint').textContent).toBe("Only €24.00 is due — Card terminal can't give change");
  expect(screen.getByTestId('tender-take').getAttribute('aria-disabled')).toBe('true');
  expect(legs()).toHaveLength(0);
  tender('card', '24.00');
  expect(screen.getByTestId('tender-paid').textContent).toBe('€24.00 of €24.00 paid');
  expect(tenderBalance()).toBe('€0.00');
  expect(screen.queryByTestId('tender-change')).toBeNull();
  const { payload } = await complete();
  expect(payload.payments).toEqual([expect.objectContaining({ method: 'external', amountMinor: 2400 })]);
  expect(payload.payments[0].changeMinor ?? 0).toBe(0);
  expect(screen.queryByTestId('paid-change-due')).toBeNull();
}, 15000);

it('removing a tender restores the balance due', async () => {
  await startSplit();
  tender('card', '10.00');
  expect(tenderBalance()).toBe('€14.00');
  // The pane's Cancel payment voids the leg: it stays on the ledger, struck through, and counts nothing.
  fireEvent.click(screen.getByTestId(/^tender-leg-.*-void$/));
  expect(screen.queryByTestId('tender-paid')).toBeNull();
  expect(headline()).toBe('Total€24.00');
  expect(tenderEntry()).toBe('€24.00');
  expect(screen.queryByTestId(/^tender-leg-.*-void$/)).toBeNull();
  expect(screen.getByTestId(/^tender-leg-.*-status$/).textContent).toBe('Cancelled');
  expect(screen.getByTestId('tender-complete').getAttribute('aria-disabled')).toBe('true');
  expect(record).not.toHaveBeenCalled();
});

// The keypad tender pane's steps exceed the 5 s default on CI runners.
it('takes a cash part and the rest on the card terminal, and records both payments against the order total', async () => {
  await startSplit();
  tender('cash', '5.00');
  expect(headline()).toBe('Remaining€19.00€5.00 of €24.00 paid');
  // The Card terminal tile prefills the balance due, so Take settles the rest.
  pickMethod('external');
  expect(tenderEntry()).toBe('€19.00');
  take();
  expect(tenderBalance()).toBe('€0.00');
  expect(screen.queryByTestId('tender-change')).toBeNull();
  const { payload } = await complete();
  expect(payload.totalMinor).toBe(2400);
  expect(payload.payments).toEqual([
    expect.objectContaining({ method: 'cash', amountMinor: 500 }),
    expect.objectContaining({ method: 'external', amountMinor: 1900 }),
  ]);
}, 15000);

it('shows the screen-only paid summary beside the receipt on wide windows', async () => {
  await startSplit();
  tender('card', '10.00');
  tender('cash', '20.00');
  await complete();
  const summary = screen.getByTestId('paid-summary');
  expect(summary.parentElement?.closest('[data-print="hide"]')).toBeTruthy();
  expect(screen.getByTestId('paid-layout').contains(summary)).toBe(true);
  for (const text of ['Card terminal', '€10.00', 'Cash', '€14.00', 'Tendered €20.00 · change €6.00', 'Total', '€24.00', 'Paid in full']) {
    expect(summary.textContent).toContain(text);
  }
  expect(summary.textContent).toContain('Paid€24.00');
  expect(summary.textContent).not.toContain('€30.00');
  expect(screen.getByTestId('paid-change-due').textContent).toContain('€6.00');
  expect(screen.getByLabelText('Card terminal: €10.00')).toBeTruthy();
  expect(screen.getByLabelText('Total: €24.00')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'New sale' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Print receipt' })).toBeTruthy();
}, 15000);

it('keeps the receipt without a paid summary at column widths', async () => {
  setWindowWidth(800);
  await startSplit();
  tender('card', '24.00');
  await complete();
  expect(screen.queryByTestId('paid-summary')).toBeNull();
  expect(screen.queryByTestId('paid-layout')).toBeNull();
  expect(screen.getByRole('button', { name: 'New sale' })).toBeTruthy();
}, 15000);
