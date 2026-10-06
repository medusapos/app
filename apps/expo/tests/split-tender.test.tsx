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
const summary = () => within(screen.getByTestId('split-tender-summary'));
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
  expect(screen.queryByText('Cash Tendered')).toBeNull();
  expect(summary().getByText('Total: €24.00')).toBeTruthy();
}
function tender(method: 'card' | 'cash', amount: string) {
  fireEvent.click(screen.getByTestId(`split-tender-method-${method}`));
  fireEvent.change(screen.getByTestId('split-tender-amount'), { target: { value: amount } });
  fireEvent.click(screen.getByTestId('split-tender-add-button'));
}
async function complete() {
  await act(async () => { fireEvent.click(screen.getByTestId('split-tender-complete')); });
  await screen.findByRole('button', { name: 'New sale' });
  expect(record).toHaveBeenCalledOnce();
  const order = record.mock.calls[0][0];
  return toOrderCreateEnvelope(order, 'register-1');
}

it('takes a card part and a cash remainder, shows change from cash only, and records both payments', async () => {
  await startSplit();
  tender('card', '10.00');
  expect(summary().getByText('Remaining: €14.00')).toBeTruthy();
  expect(summary().queryByText(/^Change:/)).toBeNull();
  expect((screen.getByTestId('split-tender-amount') as HTMLInputElement).value).toBe('14.00');
  tender('cash', '20.00');
  expect(summary().getByText('Remaining: €0.00')).toBeTruthy();
  expect(summary().getByText('Change: €6.00')).toBeTruthy();
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
  tender('card', '30.00');
  expect(summary().getByText('Paid: €24.00')).toBeTruthy();
  expect(summary().getByText('Remaining: €0.00')).toBeTruthy();
  expect(summary().queryByText(/^Change:/)).toBeNull();
  const { payload } = await complete();
  expect(payload.payments).toEqual([expect.objectContaining({ method: 'external', amountMinor: 2400 })]);
  expect(payload.payments[0].changeMinor ?? 0).toBe(0);
});

it('removing a tender restores the balance due', async () => {
  await startSplit();
  tender('card', '10.00');
  expect(summary().getByText('Remaining: €14.00')).toBeTruthy();
  fireEvent.click(screen.getByTestId(/^split-tender-remove-/));
  expect(summary().getByText('Paid: €0.00')).toBeTruthy();
  expect(summary().getByText('Remaining: €24.00')).toBeTruthy();
  expect((screen.getByTestId('split-tender-amount') as HTMLInputElement).value).toBe('24.00');
  expect(screen.queryByTestId(/^split-tender-remove-/)).toBeNull();
  expect(screen.getByTestId('split-tender-complete').getAttribute('aria-disabled')).toBe('true');
  expect(record).not.toHaveBeenCalled();
});

it('Single payment clears split payments and shows Tender; leaving tender resets the switch', async () => {
  await startSplit();
  tender('card', '10.00');
  tender('cash', '5.00');
  click('Single payment');
  expect(screen.queryByTestId('split-tender-summary')).toBeNull();
  expect(screen.getByText('Cash Tendered')).toBeTruthy();
  expect(screen.getByText('Balance due: €24.00')).toBeTruthy();
  click('Split payment');
  expect(screen.queryAllByTestId(/^split-tender-remove-/)).toHaveLength(0);
  tender('card', '10.00');
  click('Back');
  await act(async () => { click('Cash'); });
  expect(button('Split payment')).toBeTruthy();
  expect(screen.queryByTestId('split-tender-summary')).toBeNull();
  click('Split payment');
  tender('cash', '24.00');
  await complete();
  click('New sale');
  add();
  await act(async () => { click('Cash'); });
  expect(button('Split payment')).toBeTruthy();
  expect(screen.queryByTestId('split-tender-summary')).toBeNull();
  click('Split payment');
  tender('cash', '24.00');
  let rejectSave!: (error: Error) => void;
  record.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectSave = reject; }));
  await act(async () => { fireEvent.click(screen.getByTestId('split-tender-complete')); });
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
  expect(screen.getByText('Cash Tendered')).toBeTruthy();
  expect(screen.queryByTestId('split-tender-summary')).toBeNull();
  expect(record).toHaveBeenCalledTimes(2);
}, 20_000);
