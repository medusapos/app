// @vitest-environment jsdom
// The register on the sale screen (ADR 0017): a real RegisterProvider, useRegisterSession and TallyUI register
// components over a real order store (memory storage); the outbox is a stand-in whose record inserts into it.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ComponentProps, ReactNode } from 'react';
import type { CartLineProps, CartTotalProps, SearchInput, ProductGrid } from '@tallyui/components';
import { formatMoney, type StoreSettings as PricingSettings } from '@tallyui/core';
import { bindRegister, readRegister, useStoreSettings, type PosOrder } from '@tallyui/pos';
import { PortalHost } from '@tallyui/primitives';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProductsScreen from '../app/index';
import { OPEN_TO_PAY } from '../components/register';
import { openOrderStore, registerCollections } from '../lib/order-store';
import { useOutboxContext } from '../lib/outbox-context';
import { posConnector } from '../lib/pos-connector';
import { RegisterProvider } from '../lib/register-context';
import { saveSession } from '../lib/session';
import { SessionProvider } from '../lib/session-context';
import { fetchStoreSettings, saveCachedSettings, type StoreSettings } from '../lib/store-settings';
import { useReplicatedProducts } from '../lib/use-replicated-products';
import { openTestRegister } from './register-fixture';
import { setWindowWidth } from './window-width';

vi.mock('expo-router', () => ({
  Redirect: ({ href }: { href: string }) => <span>redirect:{href}</span>,
  router: { replace: vi.fn(), push: vi.fn() },
  Stack: { Screen: ({ options }: { options: { headerRight?: () => ReactNode } }) => options.headerRight?.() },
}));
vi.mock('expo-localization', () => ({ getCalendars: () => [{ uses24hourClock: null }] }));
vi.mock('../lib/use-replicated-products', () => ({ useReplicatedProducts: vi.fn() }));
vi.mock('../lib/outbox-context', () => ({ useOutboxContext: vi.fn() }));
vi.mock('@tallyui/pos', async (importOriginal) => ({
  ...await importOriginal<typeof import('@tallyui/pos')>(), useStoreSettings: vi.fn(),
}));
vi.mock('../lib/store-settings', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/store-settings')>(), fetchStoreSettings: vi.fn(),
}));
// The sale primitives as products-screen.test.tsx stubs them; the register components are real.
vi.mock('@tallyui/components/product', () => ({
  ProductGrid: ({ items, renderItem, emptyState }: ComponentProps<typeof ProductGrid>) => (
    <div>{items.length ? items.map((item, index) => <div key={item.id}>{renderItem(item, index)}</div>) : emptyState}</div>
  ),
  ProductImage: () => null,
  ProductTitle: ({ doc }: { doc: { title?: ReactNode } }) => <span>{doc.title}</span>,
  ProductPrice: () => null,
  ProductStockBadge: () => null,
}));
vi.mock('@tallyui/components/ui', () => ({ VStack: ({ children }: { children?: ReactNode }) => <div>{children}</div> }));
vi.mock('@tallyui/components/input', () => ({
  SearchInput: ({ value, onChangeText, onSubmitEditing, placeholder }: ComponentProps<typeof SearchInput>) => (
    <input value={value} placeholder={placeholder} onChange={(event) => onChangeText(event.target.value)}
      onKeyDown={(event) => { if (event.key === 'Enter') onSubmitEditing?.({} as never); }} />
  ),
}));
vi.mock('@tallyui/components/cart', () => ({
  CartPanel: <T,>({ items, renderItem, emptyState, afterItems, footer }:
    { items: T[]; renderItem: (item: T, index: number) => ReactNode; emptyState?: ReactNode; afterItems?: ReactNode; footer?: ReactNode }) => <div>
    {items.length ? items.map((item, index) => <div key={index}>{renderItem(item, index)}</div>) : emptyState}
    {afterItems}{footer}
  </div>,
  CartLine: ({ name, quantity, lineTotal }: CartLineProps) => <div>{name} × {quantity} = {formatMoney(lineTotal)}</div>,
  CartTotal: ({ total }: CartTotalProps) => <span>Total: {formatMoney(total)}</span>,
  CartLineActions: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DiscountBadge: () => null,
}));
vi.mock('@tallyui/components/checkout', () => ({ CashTendered: () => null, ChangeDisplay: () => null }));

const settings: StoreSettings = { storeName: 'Test shop', currency: 'EUR', location: { id: 'loc', name: 'Main', countryCode: 'dk' } };
const pricing: PricingSettings = { currency: 'EUR', pricesIncludeTax: false, taxRatesPpm: { default: 250000 } };
const shirt = { id: 'shirt', title: 'Shirt', status: 'published',
  variants: [{ id: 'blue', title: 'Blue', sku: 'BLUE', prices: [{ amount: 12, currency_code: 'eur' }] }] };
const button = (name: string | RegExp) => screen.getByRole('button', { name });
const pill = () => screen.queryByTestId('register-bar-pill')?.textContent ?? null;

let sequence = 0;
let baseUrl: string;
let store: Awaited<ReturnType<typeof openOrderStore>>;
let record: ReturnType<typeof vi.fn<(order: PosOrder) => Promise<void>>>;

beforeEach(async () => {
  setWindowWidth(1280);
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  });
  baseUrl = `https://register-${++sequence}.test`;
  saveCachedSettings(localStorage, baseUrl, settings);
  saveSession(localStorage, { baseUrl, email: 'admin@store.test',
    token: `header.${btoa(JSON.stringify({ exp: Date.now() / 1000 + 86400 }))}.signature` });
  vi.spyOn(posConnector, 'capabilities').mockResolvedValue(undefined);
  vi.mocked(fetchStoreSettings).mockResolvedValue(settings);
  vi.mocked(useStoreSettings).mockReturnValue({ state: 'ready', settings: pricing });
  vi.mocked(useReplicatedProducts).mockReturnValue({ products: [shirt], state: 'synced', error: null, lastSyncedAt: null,
    stockOverlay: undefined, lastStockCheckAt: null, reconcileStock: vi.fn(async () => {}), unlisted: undefined });
  store = await openOrderStore(baseUrl);
  record = vi.fn(async (order: PosOrder) => { await store.orders.insert(order); });
  vi.mocked(useOutboxContext).mockReturnValue({ orders: store.orders, state: { pending: 0, sending: false }, recent: [], savesInFlight: 0,
    record, flush: vi.fn().mockResolvedValue(undefined), requeue: vi.fn().mockResolvedValue(0), isStored: vi.fn().mockResolvedValue(false) });
});
afterEach(async () => {
  cleanup();
  await store.close();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function mount() {
  await act(async () => {
    render(<SessionProvider><RegisterProvider orders={store.orders}><ProductsScreen /></RegisterProvider><PortalHost /></SessionProvider>);
  });
}
const sessions = () => registerCollections(store.orders).sessions;
async function openPanel() {
  fireEvent.click(await screen.findByRole('button', { name: 'Open register panel' }));
  return within(await screen.findByTestId('register-panel'));
}

describe('the register on the sale screen', () => {
  it('shows the picker while unbound; a pick binds it and shows the open card; opening with a float shows the cart and the bar', async () => {
    await mount();
    expect(await screen.findByTestId('register-picker')).toBeTruthy();
    expect(pill()).toBe('Choose a register');
    await act(async () => { fireEvent.click(screen.getByTestId('register-picker-row-register-1')); });
    expect(await screen.findByTestId('open-register-card')).toBeTruthy();
    expect(screen.queryByTestId('register-picker')).toBeNull();
    const bound = (await readRegister(sessions()))!.stores[baseUrl];
    expect([bound.register_id, bound.register_name]).toEqual(['register-1', 'Register 1']);
    await waitFor(() => expect(pill()).toBe('Register closed'));

    fireEvent.change(screen.getByTestId('open-register-amount'), { target: { value: '100.00' } });
    await act(async () => { fireEvent.click(screen.getByTestId('open-register-button')); });
    await waitFor(() => expect(screen.queryByTestId('open-register-card')).toBeNull());
    expect(screen.getByText('Scan or tap a product to start a sale.')).toBeTruthy();
    expect(screen.getByTestId('register-bar')).toBeTruthy();
    expect(pill()).toBeNull();
    expect(button('Open register panel')).toBeTruthy();
    const [row] = (await sessions().find().exec()).map((doc) => doc.toJSON());
    expect(row).toMatchObject({ register_id: 'register-1', status: 'open', counted_float_minor: 10000, opened_by: 'admin@store.test' });
  });

  it.each([['unbound', 'register-picker'], ['bound, not open', 'open-register-card']])(
    'while %s, taps and scans still add to the cart, and Cash and Card refuse above it without starting the tender',
    async (state, gate) => {
      if (state !== 'unbound') await bindRegister(sessions(), baseUrl, { id: 'register-1', name: 'Register 1' });
      await mount();
      const card = await screen.findByTestId(gate);
      fireEvent.click(button('Shirt'));
      const search = screen.getByPlaceholderText('Search or scan barcode / SKU');
      fireEvent.change(search, { target: { value: 'BLUE' } });
      fireEvent.keyDown(search, { key: 'Enter' });
      expect(screen.getByText('Shirt × 2 = €24.00')).toBeTruthy();
      for (const method of ['Cash', 'Card terminal']) {
        await act(async () => { fireEvent.click(button(method)); });
        expect(screen.getByRole('alert').textContent).toBe(OPEN_TO_PAY);
        expect(screen.queryByRole('button', { name: /Complete sale|Payment approved on terminal/ })).toBeNull();
        // Above the cart, which is still there to use.
        expect(card.compareDocumentPosition(button(method)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      }
      expect(record).not.toHaveBeenCalled();
    });

  it('stamps a completed sale with the open session, and the panel counts it', async () => {
    const session = await openTestRegister(store.orders, baseUrl);
    await mount();
    await screen.findByRole('button', { name: 'Open register panel' });
    fireEvent.click(button('Shirt'));
    await act(async () => { fireEvent.click(button('Card terminal')); });
    expect(screen.queryByRole('alert')).toBeNull();
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Payment approved on terminal' })); });
    expect(record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sessionId: session.id, totalMinor: 1500 }));
    expect(record.mock.calls[0][0]).not.toHaveProperty('lateSessionId');
    await act(async () => { fireEvent.click(button('New sale')); });
    const panel = await openPanel();
    await waitFor(() => expect(panel.getByTestId('register-panel-sales-count').textContent).toBe('1 sales this session'));
  });

  it('records a paid in of 5.00 from the panel, and Undo voids it', async () => {
    const session = await openTestRegister(store.orders, baseUrl);
    await mount();
    const panel = await openPanel();
    fireEvent.click(panel.getByTestId('register-panel-paid-in'));
    const sheet = within(await screen.findByTestId('movement-sheet'));
    fireEvent.change(sheet.getByTestId('movement-amount'), { target: { value: '5.00' } });
    fireEvent.change(sheet.getByTestId('movement-reason'), { target: { value: 'Change' } });
    await act(async () => { fireEvent.click(sheet.getByTestId('movement-confirm')); });
    await waitFor(() => expect(screen.queryByTestId('movement-sheet')).toBeNull());
    const { movements } = registerCollections(store.orders);
    const [paidIn] = (await movements.find().exec()).map((doc) => doc.toJSON());
    expect(paidIn).toMatchObject({ session_id: session.id, type: 'paid_in', amountMinor: 500, reason: 'Change', created_by: 'admin@store.test' });
    fireEvent.click(panel.getByTestId('register-panel-movements'));
    expect((await panel.findByTestId(`movement-row-${paidIn.id}`)).textContent).toBe('Paid in · €5.00 · Change');
    await act(async () => { fireEvent.click(panel.getByTestId(`movement-void-${paidIn.id}`)); });
    await waitFor(() => expect(panel.queryByTestId(`movement-row-${paidIn.id}`)).toBeNull());
    const rows = (await movements.find().exec()).map((doc) => doc.toJSON());
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.type === 'void')).toMatchObject({ voids: paidIn.id, amountMinor: 500 });
  });

  it('Close register starts counting, which shows the count slot until Back to selling', async () => {
    await openTestRegister(store.orders, baseUrl);
    await mount();
    const panel = await openPanel();
    await act(async () => { fireEvent.click(panel.getByTestId('register-panel-close')); });
    expect(await screen.findByText('Counting arrives in the next update.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cash' })).toBeNull();
    await waitFor(() => expect(pill()).toBe('Counting'));
    await act(async () => { fireEvent.click(button('Back to selling')); });
    await waitFor(() => expect(screen.queryByText('Counting arrives in the next update.')).toBeNull());
    expect(button('Cash')).toBeTruthy();
    expect((await sessions().find().exec())[0].status).toBe('open');
  });
});
