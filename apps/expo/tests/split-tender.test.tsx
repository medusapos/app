// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PortalHost } from '@tallyui/primitives';
import { toOrderCreateEnvelope, type PosOrder } from '@tallyui/pos';
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
import { takeLeg, tenderBalance, tenderEntry } from './tender-pane';

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
const button = (name: string) => screen.getByRole('button', { name });
const click = (name: string) => fireEvent.click(button(name));
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
  vi.mocked(useSession).mockReturnValue({ session, signIn: vi.fn(), signOut: vi.fn(), reportUnauthorized: vi.fn(),
    reportNoPosAccess: vi.fn(), signOutNotice: null,
    mergeCapabilities: vi.fn(), setSaleHold: vi.fn(), setSavesHold: vi.fn(), signOutDeferred: false });
  capabilities.mockResolvedValue(session.capabilities);
  storeSettings.mockResolvedValue({ currency: 'EUR', pricesIncludeTax: false, taxRatesPpm: { default: 250000 },
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
async function startSplit() {
  await act(async () => { render(<><ProductsScreen /><PortalHost /></>); });
  await screen.findByTestId('product-tile-Shirt');
  add();
  await act(async () => { click('Cash'); });
  click('Split payment');
  // TallyUI 3.14.0: SplitTender renders the one tender pane, which takes split legs itself; the switch now reads Single payment.
  expect(button('Single payment')).toBeTruthy();
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
});

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
});

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

it('Single payment clears split payments and shows Tender; leaving tender resets the switch', async () => {
  await startSplit();
  tender('card', '10.00');
  tender('cash', '5.00');
  expect(legs()).toHaveLength(2);
  click('Single payment');
  expect(button('Split payment')).toBeTruthy();
  expect(legs()).toHaveLength(0);
  expect(within(screen.getByTestId('tender-ledger')).getByText('No payments yet')).toBeTruthy();
  expect(headline()).toBe('Total€24.00');
  click('Split payment');
  expect(legs()).toHaveLength(0);
  tender('card', '10.00');
  click('Back');
  await act(async () => { click('Cash'); });
  expect(button('Split payment')).toBeTruthy();
  expect(legs()).toHaveLength(0);
  click('Split payment');
  tender('cash', '24.00');
  await complete();
  click('New sale');
  add();
  await act(async () => { click('Cash'); });
  expect(button('Split payment')).toBeTruthy();
  expect(legs()).toHaveLength(0);
  click('Split payment');
  tender('cash', '24.00');
  let rejectSave!: (error: Error) => void;
  record.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectSave = reject; }));
  await act(async () => { fireEvent.click(screen.getByTestId('tender-complete')); });
  await waitFor(() => expect(record).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole('button', { name: /^(Single|Split) payment$/ })).toBeNull();
  await act(async () => { rejectSave(new Error('Stored, but save acknowledgement failed')); });
  await screen.findByRole('button', { name: 'Continue' });
  expect(screen.queryByRole('button', { name: /^(Single|Split) payment$/ })).toBeNull();
  click('Continue');
  expect(screen.getByTestId('cart-empty')).toBeTruthy();
  add();
  await act(async () => { click('Cash'); });
  expect(button('Split payment')).toBeTruthy();
  expect(screen.getByTestId('tender-pane')).toBeTruthy();
  expect(legs()).toHaveLength(0);
  expect(record).toHaveBeenCalledTimes(2);
}, 20_000);
