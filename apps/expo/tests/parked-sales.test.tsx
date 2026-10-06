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
const logged: LogEntry[] = [];
const button = (name: string | RegExp) => screen.getByRole('button', { name });
const add = () => fireEvent.click(screen.getByTestId('product-tile-Shirt'));
const drafts = () => draftsCollection(store.orders)!;
const row = (label: string) => within(screen.getByTestId('cart-footer')).getByText(label).parentElement!.textContent;
beforeEach(async () => {
  setWindowWidth(1280);
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  });
  const session = { baseUrl: `https://parked-${crypto.randomUUID()}.test`, email: 'admin@store.test', token: 'jwt',
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
    variants: [{ id: 'blue', title: 'Blue', sku: 'BLUE', prices: [{ amount: 12, currency_code: 'eur' }] }] }],
    state: 'synced', error: null, lastSyncedAt: null, stockOverlay: undefined, lastStockCheckAt: null,
    reconcileStock: vi.fn(async () => {}), pullNotice: undefined, resumePull: vi.fn(), unlisted: undefined });
  store = await openOrderStore(session.baseUrl);
  vi.mocked(useOutboxContext).mockReturnValue({ orders: store.orders, record, state: { pending: 0, sending: false },
    recent: [], savesInFlight: 0, stuckCommandIds: [], flush: vi.fn(), requeue: vi.fn(), isStored: vi.fn() });
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
async function park() {
  fireEvent.click(button(/^Parked sales/));
  await act(async () => { fireEvent.click(screen.getByTestId('parked-sales-park')); });
  await screen.findAllByTestId(/^parked-resume-/);
}
function price(value = '10.00') {
  fireEvent.click(screen.getByText('Price', { exact: true }));
  fireEvent.change(screen.getByLabelText('Price value'), { target: { value } });
  fireEvent.change(screen.getByLabelText('Reason (optional)'), { target: { value: 'Shelf price' } });
  fireEvent.click(screen.getByTestId('price-apply'));
}
async function complete() {
  await act(async () => { fireEvent.click(button('Card terminal')); });
  await act(async () => { fireEvent.click(button('Payment approved on terminal')); });
  await waitFor(() => expect(record).toHaveBeenCalledOnce());
  return record.mock.calls[0][0];
}

it('parks the cart from the Parked sales sheet, starts an empty sale, and resumes the parked cart with its lines', async () => {
  await mount();
  add(); add();
  await park();
  expect(await drafts().find().exec()).toHaveLength(1);
  fireEvent.click(screen.getByTestId('parked-sales-dismiss'));
  expect(screen.getByTestId('cart-empty')).toBeTruthy();
  expect(row('Total')).toBe('Total€0.00');
  add();
  expect(screen.getByText('€12.00 × 1')).toBeTruthy();
  fireEvent.click(button('Remove Shirt'));
  fireEvent.click(button('Parked sales (1)'));
  await act(async () => { fireEvent.click(screen.getByTestId(/^parked-resume-/)); });
  expect(screen.getByText('€12.00 × 2')).toBeTruthy();
  expect(row('Total')).toBe('Total€30.00');
  expect(await drafts().find().exec()).toHaveLength(0);
  expect(record).not.toHaveBeenCalled();
});

it('a parked sale resumed after a catalogue price change is re-priced to today\'s price, with TallyUI\'s Prices changed note', async () => {
  const view = await mount();
  add();
  expect(screen.getByText('€12.00 × 1')).toBeTruthy();
  await park();
  const replicated = vi.mocked(useReplicatedProducts).mock.results.at(-1)!.value;
  const product = replicated.products[0];
  vi.mocked(useReplicatedProducts).mockReturnValue({ ...replicated, products: [{ ...product,
    variants: [{ ...product.variants[0], prices: [{ amount: 15, currency_code: 'eur' }] }] }] });
  view.rerender(<><ProductsScreen /><PortalHost /></>);
  await act(async () => { fireEvent.click(screen.getByTestId(/^parked-resume-/)); });
  expect(screen.getByText('€15.00 × 1').parentElement!.parentElement!.textContent).toBe('Shirt€15.00 × 1€15.00');
  expect([row('Subtotal'), row('VAT 25%'), row('Total')]).toEqual(['Subtotal€15.00', 'VAT 25%€3.75', 'Total€18.75']);
  expect(screen.getByText("Prices changed since this sale was parked: 1 line updated to today's price.")).toBeTruthy();
});

it('a variant no longer in the catalogue keeps its parked price on resume', async () => {
  const view = await mount();
  add(); await park();
  const replicated = vi.mocked(useReplicatedProducts).mock.results.at(-1)!.value;
  vi.mocked(useReplicatedProducts).mockReturnValue({ ...replicated, products: [] });
  view.rerender(<><ProductsScreen /><PortalHost /></>);
  expect(screen.queryByTestId('product-tile-Shirt')).toBeNull();
  await act(async () => { fireEvent.click(screen.getByTestId(/^parked-resume-/)); });
  expect(screen.getByText('€12.00 × 1')).toBeTruthy();
  expect(row('Total')).toBe('Total€15.00');
  expect(screen.queryByText(/Prices changed/)).toBeNull();
});

it('an unchanged catalogue resumes at the same prices with no Prices changed note', async () => {
  await mount(); add(); await park();
  await act(async () => { fireEvent.click(screen.getByTestId(/^parked-resume-/)); });
  expect(screen.getByText('€12.00 × 1')).toBeTruthy();
  expect(row('Total')).toBe('Total€15.00');
  expect(screen.queryByText(/Prices changed/)).toBeNull();
});

it('the opener counts parked sales', async () => {
  await mount();
  expect(button('Parked sales')).toBeTruthy();
  for (const count of [1, 2]) {
    add();
    await park();
    fireEvent.click(screen.getByTestId('parked-sales-dismiss'));
    expect(await screen.findByRole('button', { name: `Parked sales (${count})` })).toBeTruthy();
  }
});

it('discarding a parked sale asks first, then removes it', async () => {
  await mount(); add(); await park();
  const [draft] = await drafts().find().exec();
  fireEvent.click(screen.getByTestId(`parked-discard-${draft.id}`));
  expect(screen.getByText('Discard this parked sale?')).toBeTruthy();
  expect(await drafts().find().exec()).toHaveLength(1);
  fireEvent.click(screen.getByTestId(`parked-discard-cancel-${draft.id}`));
  expect(await drafts().find().exec()).toHaveLength(1);
  fireEvent.click(screen.getByTestId(`parked-discard-${draft.id}`));
  await act(async () => { fireEvent.click(screen.getByTestId(`parked-discard-confirm-${draft.id}`)); });
  expect(await screen.findByTestId('parked-sales-empty')).toBeTruthy();
  expect(await drafts().find().exec()).toHaveLength(0);
  fireEvent.click(screen.getByTestId('parked-sales-dismiss'));
  expect(button('Parked sales')).toBeTruthy();
  expect(record).not.toHaveBeenCalled();
});

it('the Price action on a line changes its unit price, and the line and total follow', async () => {
  await mount(); add(); add();
  fireEvent.click(screen.getByText('Discount', { exact: true }));
  fireEvent.change(screen.getByLabelText('Discount value'), { target: { value: '10' } });
  fireEvent.click(button('Apply'));
  price();
  expect(screen.getByText('€10.00 × 2').parentElement!.parentElement!.textContent).toBe('Shirt€10.00 × 2€20.00');
  expect([row('Subtotal'), row('Discount'), row('VAT 25%'), row('Total')])
    .toEqual(['Subtotal€20.00', 'Discount−€2.00', 'VAT 25%€4.50', 'Total€22.50']);
});

it('a sale with an edited price is recorded with that unitPriceMinor', async () => {
  await mount(); add(); price();
  const order = await complete();
  expect(order.lines).toEqual([expect.objectContaining({ unitPriceMinor: 1000, quantity: 1 })]);
  expect(order.totalMinor).toBe(1250);
});

it('logs the price change with from, to and reason', async () => {
  await mount(); add(); price();
  await park();
  const [draft] = await drafts().find().exec();
  const lineId = JSON.parse(draft.data).lineItems[0].id;
  expect(logged.filter((entry) => entry.message === 'Price changed')).toEqual([expect.objectContaining({ level: 'info',
    data: { lineId, fromMinor: 1200, toMinor: 1000, reason: 'Shelf price' } })]);
});
