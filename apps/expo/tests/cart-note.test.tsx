// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { useSale } from '@tallyui/pos';
import { PortalHost } from '@tallyui/primitives';
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

const { observed } = vi.hoisted(() => ({ observed: { sale: null as ReturnType<typeof useSale> | null } }));
vi.mock('../lib/pos-connector', async (original) => (await import('./pos-connector-mock')).mockPosConnector(original));
// Observe the real hook's state, so a test can read the sale's note.
vi.mock('@tallyui/pos', async (original) => {
  const actual = await original<typeof import('@tallyui/pos')>();
  return { ...actual, useSale: (...args: Parameters<typeof actual.useSale>) => {
    const sale = actual.useSale(...args); observed.sale = sale; return sale;
  } };
});
vi.mock('expo-router', () => ({ Redirect: () => null, Stack: { Screen: () => null } }));
vi.mock('expo-linking', () => ({ openURL: vi.fn().mockResolvedValue(true) }));
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
beforeEach(async () => {
  setWindowWidth(1280);
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } });
  const session = { baseUrl: `https://note-${crypto.randomUUID()}.test`, email: 'admin@store.test', token: 'jwt',
    capabilities: { orderCreate: 7, taxRounding: { granularity: 'per_order' as const, mode: 'half_away_from_zero' as const } } };
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
    reconcileStock: vi.fn(async () => {}), pullNotice: undefined, resumePull: vi.fn(), unlisted: undefined });
  store = await openOrderStore(session.baseUrl);
  vi.mocked(useOutboxContext).mockReturnValue({ orders: store.orders, record: vi.fn(), state: { pending: 0, sending: false },
    recent: [], savesInFlight: 0, stuckCommandIds: [], flush: vi.fn(), requeue: vi.fn(), isStored: vi.fn() });
});
afterEach(async () => {
  cleanup(); await store.close(); vi.unstubAllGlobals(); vi.resetAllMocks(); observed.sale = null;
});

const button = (name: string) => screen.getByRole('button', { name });
const field = () => screen.getByTestId('cart-note-field') as HTMLTextAreaElement;
async function mount({ shirt = true } = {}) {
  await act(async () => { render(<><ProductsScreen /><PortalHost /></>); });
  await screen.findByTestId('product-tile-Shirt');
  if (shirt) fireEvent.click(screen.getByTestId('product-tile-Shirt'));
}
/** The link opens the dialog; the note is typed and Done closes it. */
function addNote(note: string) {
  fireEvent.click(screen.getByTestId('cart-note-add'));
  expect(screen.getByTestId('cart-note-dialog')).toBeTruthy();
  fireEvent.change(field(), { target: { value: note } });
  fireEvent.click(button('Done'));
}
const rowText = () => screen.getByTestId('cart-note-text').textContent;

it('the link opens the note dialog, and Done shows the note as its own row in place of the link', async () => {
  await mount();
  expect(screen.getByText('Add order note')).toBeTruthy();
  expect(screen.queryByTestId('cart-note-row')).toBeNull();
  addNote('Gift wrap, please');
  expect(screen.queryByTestId('cart-note-dialog')).toBeNull();
  expect(screen.getByTestId('cart-note-row')).toBeTruthy();
  expect(rowText()).toBe('Gift wrap, please');
  expect(screen.queryByTestId('cart-note-add')).toBeNull();
  expect(screen.queryByText('Add order note')).toBeNull();
  expect(observed.sale!.order.note).toBe('Gift wrap, please');
});

it('pressing the row opens the dialog holding the note, to edit it', async () => {
  await mount(); addNote('Gift wrap, please');
  fireEvent.click(screen.getByTestId('cart-note-row'));
  expect(screen.getByTestId('cart-note-dialog')).toBeTruthy();
  expect(field().value).toBe('Gift wrap, please');
  fireEvent.change(field(), { target: { value: 'Ring the bell' } });
  fireEvent.click(button('Done'));
  expect(screen.queryByTestId('cart-note-dialog')).toBeNull();
  expect(rowText()).toBe('Ring the bell');
});

it('Clear empties the note, closes the dialog, removes the row and brings the link back', async () => {
  await mount(); addNote('Gift wrap, please');
  fireEvent.click(screen.getByTestId('cart-note-row'));
  fireEvent.click(button('Clear'));
  expect(screen.queryByTestId('cart-note-dialog')).toBeNull();
  expect(screen.queryByTestId('cart-note-row')).toBeNull();
  expect(screen.getByTestId('cart-note-add')).toBeTruthy();
  expect(observed.sale!.order.note ?? '').toBe('');
});

it('an empty cart shows the note row too', async () => {
  await mount({ shirt: false });
  expect(screen.getByTestId('cart-empty')).toBeTruthy();
  addNote('Gift wrap, please');
  expect(observed.sale!.order.lineItems).toHaveLength(0);
  expect(rowText()).toBe('Gift wrap, please');
  expect(screen.queryByTestId('cart-note-add')).toBeNull();
});

it('starting a tender closes the dialog, and a cancelled tender does not reopen it', async () => {
  await mount(); addNote('Gift wrap, please');
  fireEvent.click(screen.getByTestId('cart-note-row'));
  expect(screen.getByTestId('cart-note-dialog')).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByTestId('cart-checkout')); });
  expect(screen.queryByTestId('cart-note-dialog')).toBeNull();
  expect(screen.getByTestId('tender-pane')).toBeTruthy();
  await act(async () => { observed.sale!.cancelTender(); });
  expect(screen.queryByTestId('tender-pane')).toBeNull();
  expect(screen.queryByTestId('cart-note-dialog')).toBeNull();
  expect(rowText()).toBe('Gift wrap, please');
});

it('on a phone, the Cart tab shows the link, and the note row opens the dialog', async () => {
  setWindowWidth(360, 780);
  await mount();
  fireEvent.click(screen.getByRole('tab', { name: /^Cart, / }));
  addNote('Gift wrap, please');
  expect(rowText()).toBe('Gift wrap, please');
  fireEvent.click(screen.getByTestId('cart-note-row'));
  expect(screen.getByTestId('cart-note-dialog')).toBeTruthy();
  expect(field().value).toBe('Gift wrap, please');
});
