// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState, type ComponentProps, type ReactNode } from 'react';
import { BehaviorSubject } from 'rxjs';
import type { ProductGrid, SearchInput, CartLineProps, CartTotalProps } from '@tallyui/components';
import { formatStockSyncTime, SyncStatus } from '@tallyui/components';
import { formatMoney, SignInError, type StoreSettings as PricingSettings } from '@tallyui/core';
import type { StorageHealth as StorageHealthReading } from '@tallyui/database';
import { createOrderBuilder, finalizeOrder, useOrderOutbox, useStoreSettings, type PosOrder } from '@tallyui/pos';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { router } from 'expo-router';
import { EARLIER_SALE_SAVING } from '../components/earlier-sale-note';
import { clearProductCache } from '../lib/product-cache';
import { saveScannerSettings } from '../lib/scanner-settings';
import { login, LoginError, refreshSession, saveSession } from '../lib/session';
import { capabilities } from './pos-connector-mock';
import { SessionProvider, useSession } from '../lib/session-context';
import { watchStorageHealth } from '../lib/storage-health';
import { useReplicatedProducts } from '../lib/use-replicated-products';
import { fetchStoreSettings, saveCachedSettings, StoreSettingsError, type StoreSettings } from '../lib/store-settings';
import ProductsScreen from '../app/index';
import OrdersScreen from '../app/orders';
import { OutboxProvider, useOutboxContext } from '../lib/outbox-context';
import { OutboxStrip, StoreRefused } from '../components/store-refused';
import { useRegister } from '../lib/register-context';
import { openRegisterFixture } from './register-fixture';
import { setWindowWidth } from './window-width';

vi.mock('../lib/pos-connector', async (importOriginal) => (await import('./pos-connector-mock')).mockPosConnector(importOriginal));
vi.mock('expo-router', () => ({
  Redirect: ({ href }: { href: string }) => <span>redirect:{href}</span>,
  router: { replace: vi.fn(), push: vi.fn() },
  Stack: { Screen: ({ options }: { options: { headerRight?: () => ReactNode } }) => options.headerRight?.() },
}));
// expo-localization's native module isn't available under vitest.
vi.mock('expo-localization', () => ({ getCalendars: () => [{ uses24hourClock: null }] }));
vi.mock('../lib/use-replicated-products', () => ({ useReplicatedProducts: vi.fn() }));
// A fixed outbox value, except in the hung-save tests: those run the real OutboxProvider and useOutboxContext
// (kept in `realOutbox`) over a stand-in for TallyUI's useOrderOutbox.
const realOutbox = vi.hoisted(() => ({} as { useOutboxContext: typeof import('../lib/outbox-context').useOutboxContext }));
vi.mock('../lib/outbox-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/outbox-context')>();
  realOutbox.useOutboxContext = actual.useOutboxContext;
  return { ...actual, useOutboxContext: vi.fn() };
});
// The register (ADR 0017): bound and open (register-fixture.ts), so sales can be paid; register-screen.test.tsx
// covers the gate itself. OutboxProvider's own RegisterProvider passes through: the hung-save tests' orders are a stand-in.
vi.mock('../lib/register-context', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/register-context')>(),
  RegisterProvider: ({ children }: { children: ReactNode }) => children, useRegister: vi.fn(),
}));
vi.mock('expo-linking', () => ({ openURL: vi.fn().mockResolvedValue(true) }));
vi.mock('../lib/product-cache', () => ({ clearProductCache: vi.fn().mockResolvedValue(undefined) }));
// The session's network calls, driven per test (the sign-out paths below); everything else in it is real.
vi.mock('../lib/session', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/session')>(), login: vi.fn(), refreshSession: vi.fn(),
}));
// store-settings-flow.test.tsx covers the settings states; here the store settings are ready.
vi.mock('@tallyui/pos', async (importOriginal) => ({
  ...await importOriginal<typeof import('@tallyui/pos')>(), useStoreSettings: vi.fn(), useOrderOutbox: vi.fn(),
}));
vi.mock('../lib/store-settings', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/store-settings')>(), fetchStoreSettings: vi.fn(),
}));
// Cart, CartBar, Tender, Catalogue, SyncStatus and StoreSettingsChoiceScreen come from
// @tallyui/components (TallyUI TV6a/TV6b), real and unmocked (imported directly where used).
// The primitives they compose internally (from '../cart', '../checkout', '../product', '../input',
// not the barrel) are mocked below at those module ids (aliased to their source in
// vitest.config.ts), not by path.
vi.mock('@tallyui/components/product', () => ({
  ProductGrid: ({ items, renderItem, emptyState, numColumns }: ComponentProps<typeof ProductGrid>) => (
    <div data-testid="product-grid" data-columns={numColumns}>{items.length ? items.map((item, index) => <div key={item.id}>{renderItem(item, index)}</div>) : emptyState}</div>
  ),
  // The tile is composed directly in catalogue.tsx (ProductCard has no children slot); these
  // stand in for its pieces. Only ProductTitle needs to render visible content — this file's
  // tests aren't about price or the tile badge (see catalogue.test.tsx) and the tile's
  // accessibilityRole="button" name must stay exactly the product name for the button-role
  // assertions below.
  ProductImage: () => null,
  ProductTitle: ({ doc }: { doc: { title?: ReactNode } }) => <span>{doc.title}</span>,
  ProductPrice: () => null,
  ProductStockBadge: () => null,
}));
vi.mock('@tallyui/components/ui', () => ({
  VStack: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
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
  CartLine: ({ name, quantity, unitPrice, lineTotal }: CartLineProps) =>
    <div>{name}: {formatMoney(unitPrice)} × {quantity} = {formatMoney(lineTotal)}</div>,
  CartTotal: ({ subtotal, total, taxLines }: CartTotalProps) => <div>
    <span>Subtotal: {formatMoney(subtotal)}</span>
    {taxLines?.map((line, index) => <span key={index}>{line.label}: {formatMoney(line.amount)}</span>)}
    <span>Total: {formatMoney(total)}</span>
  </div>,
  CartLineActions: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DiscountBadge: () => null,
}));
vi.mock('@tallyui/components/checkout', () => ({
  CashTendered: () => null,
  ChangeDisplay: () => null,
}));

type Replicated = ReturnType<typeof useReplicatedProducts>;
const reconcileStock = vi.fn(async () => {});
const replicated = (over: Partial<Replicated>): Replicated => ({ products: [], state: 'synced', error: null,
  lastSyncedAt: null, stockOverlay: undefined, lastStockCheckAt: null, reconcileStock, unlisted: undefined,
  pullNotice: undefined, resumePull: vi.fn(), ...over });

const settings: StoreSettings = {
  storeName: 'Test shop', currency: 'EUR', location: { id: 'loc', name: 'Main', countryCode: 'dk' },
};
const pricing: PricingSettings = {
  currency: 'EUR', pricesIncludeTax: false, taxRatesPpm: { default: 250000 },
  pricingContext: { region_id: 'reg_eu', currency_code: 'eur', publishable_key: 'pk_1' },
};
beforeEach(() => {
  setWindowWidth(1280);
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  });
  saveCachedSettings(localStorage, 'https://store.test', settings);
  capabilities.mockResolvedValue(undefined);
  vi.mocked(fetchStoreSettings).mockResolvedValue(settings);
  vi.mocked(useStoreSettings).mockReturnValue({ state: 'ready', settings: pricing });
  vi.mocked(useReplicatedProducts).mockReturnValue(replicated({}));
  vi.mocked(useRegister).mockReturnValue(openRegisterFixture());
  // Not null by default: the order store is open unless a test says otherwise (#86 review, item 5).
  vi.mocked(useOutboxContext).mockReturnValue({ orders: {} as never, state: { pending: 0, sending: false }, recent: [], savesInFlight: 0, stuckCommandIds: [], record: vi.fn().mockResolvedValue(undefined), flush: vi.fn().mockResolvedValue(undefined), requeue: vi.fn().mockResolvedValue(0), isStored: vi.fn().mockResolvedValue(false) });
});

describe('ProductsScreen catalogue', () => {
  it('shows a stopped product pull above the sales line', async () => {
    vi.mocked(useReplicatedProducts).mockReturnValue(replicated({
      pullNotice: { code: 'unauthorized', since: 0, fixedBy: 'till' },
    }));
    await mount();
    const notice = screen.getByText("Products aren't updating: this till needs to sign in to the online store again.");
    const sales = screen.getByText('Sales are up to date.');
    expect(notice.compareDocumentPosition(sales) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keeps search focusable and editable with the authRequired strip in the title slot and header actions present', async () => {
    const { SignInAgain } = await import('../components/sign-in-again');
    vi.mocked(useOutboxContext).mockReturnValue({ ...useOutboxContext(), state: { pending: 1, sending: false, authRequired: true } });
    await mount();
    const setOptions = vi.fn<NonNullable<Parameters<typeof SignInAgain>[0]['header']>['setOptions']>();
    const banner = render(<SessionProvider><SignInAgain header={{ setOptions }} /></SessionProvider>);
    expect(banner.container.textContent).toBe('');
    render(<header>{setOptions.mock.lastCall![0].headerTitle!()}</header>);
    expect(screen.getByText('1 sale saved, waiting to send ·').closest('header')).toBeTruthy();
    const input = screen.getByPlaceholderText('Search or scan barcode / SKU') as HTMLInputElement;
    expect(getComputedStyle(input).display).not.toBe('none');
    expect(getComputedStyle(input).visibility).toBe('visible');
    act(() => input.focus());
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: '123456' } });
    expect(input.value).toBe('123456');
    fireEvent.click(screen.getByRole('button', { name: 'Orders' }));
    expect(router.push).toHaveBeenCalledWith('/orders');
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(localStorage.getItem('medusapos.session')).toBeNull();
  });

  it('keeps the scan box usable with the refused strip in the header title', async () => {
    vi.mocked(useOutboxContext).mockReturnValue({ ...useOutboxContext(), state: { pending: 1, sending: false, refused: { status: 400, reason: 'protocol' } } });
    await mount();
    const setOptions = vi.fn<NonNullable<Parameters<typeof StoreRefused>[0]['header']>['setOptions']>();
    const banner = render(<StoreRefused header={{ setOptions }} />);
    expect(banner.container.textContent).toBe('');
    render(<header>{setOptions.mock.lastCall![0].headerTitle!()}</header>);
    expect(screen.getByText('1 sale not accepted ·').closest('header')).toBeTruthy();
    const input = screen.getByPlaceholderText('Search or scan barcode / SKU') as HTMLInputElement;
    act(() => input.focus());
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: '123456' } });
    expect(input.value).toBe('123456');
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(getComputedStyle(screen.getByRole('heading', { name: 'Not accepted by the store' }).parentElement!).position).toBe('absolute');
    expect(setOptions.mock.lastCall![0].headerTitle).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: 'Later' }));
    expect(setOptions.mock.lastCall![0].headerTitle).toBeTypeOf('function');
  });

  it('shows only sign-in when both authRequired and refused are set', async () => {
    vi.mocked(useOutboxContext).mockReturnValue({ ...useOutboxContext(), state: { pending: 1, sending: false, authRequired: true, refused: { status: 400, reason: 'protocol' } } });
    await mount();
    render(<SessionProvider><OutboxStrip>{null}</OutboxStrip></SessionProvider>);
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Details' })).toBeNull();
  });

  it('uses the catalogue layout width for two to six columns with room for 160 px tiles', async () => {
    await mount();
    const grid = screen.getByTestId('product-grid');
    const pane = grid.parentElement as HTMLElement & {
      __reactLayoutHandler: (event: { nativeEvent: { layout: { width: number } } }) => void;
    };
    expect(grid.getAttribute('data-columns')).toBe('2');
    for (const [width, columns] of [[300, 2], [511, 2], [512, 3], [680, 4], [848, 5], [1016, 6], [1600, 6], [400, 2]]) {
      act(() => pane.__reactLayoutHandler({ nativeEvent: { layout: { width } } }));
      expect(grid.getAttribute('data-columns')).toBe(String(columns));
    }
  });
  it('keeps cached sellable products sorted while offline and adds selections to the cart', async () => {
    const product = (id: string, title: string, status = 'published') => ({
      id, title, status, variants: [{ id: `${id}-one`, title: 'One size', sku: id,
        prices: [{ amount: 12.5, currency_code: 'eur' }] }],
    });
    vi.mocked(useReplicatedProducts).mockReturnValue(replicated({
      // SKU "zebra": Enter looks a code up only from the till's minimum scan length (3 by default, ADR 0016).
      products: [product('zebra', 'Zebra'), product('draft', 'Draft', 'draft'), product('a', 'Apple')],
      state: 'offline', error: 'Failed to fetch',
    }));
    await mount();
    expect(screen.getByText('MedusaJS · Offline · cached catalogue · 2 products · Failed to fetch')).toBeTruthy();
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(['Orders', 'Settings', 'Sign out', 'Offline', 'Register ›', 'Apple', 'Zebra', 'Cash', 'Card terminal']);
    expect(screen.getByLabelText('Sales are up to date.').textContent).toBe('Sales are up to date.');
    fireEvent.click(screen.getByRole('button', { name: 'Apple' }));
    expect(screen.getByText('Apple: €12.50 × 1 = €12.50')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('Search or scan barcode / SKU'), { target: { value: 'zebra' } });
    fireEvent.keyDown(screen.getByPlaceholderText('Search or scan barcode / SKU'), { key: 'Enter' });
    expect(screen.getByText('Zebra: €12.50 × 1 = €12.50')).toBeTruthy();
    expect(screen.getByText('Apple: €12.50 × 1 = €12.50')).toBeTruthy();
  });

  it.each([
    [undefined, 'MedusaJS · Up to date · 0 products'],
    [{ count: 0, stale: false }, 'MedusaJS · Up to date · 0 products'],
    [{ count: 1, stale: false }, 'MedusaJS · Up to date · 0 products · 1 not sold in this channel'],
    [{ count: 1200, stale: true }, 'MedusaJS · Up to date · 0 products · 1,200 not sold in this channel (last check failed)'],
  ])('shows the unlisted count %j on the status line', async (unlisted, text) => {
    vi.mocked(useReplicatedProducts).mockReturnValue(replicated({ unlisted }));
    await mount();
    expect(screen.getByText(text)).toBeTruthy();
  });

  it.each([
    [0, 'MedusaJS · Up to date · 0 products'],
    [1, 'MedusaJS · Up to date · 1 product'],
    [2, 'MedusaJS · Up to date · 2 products'],
    [1234, 'MedusaJS · Up to date · 1,234 products'],
  ])('with %i sellable products the status line reads %j', async (count, text) => {
    const products = Array.from({ length: count }, (_, i) => ({ id: `p${i}`, title: `Product ${i}`, status: 'published',
      variants: [{ id: `p${i}-v`, title: 'One size', sku: `p${i}`, prices: [{ amount: 1, currency_code: 'eur' }] }] }));
    vi.mocked(useReplicatedProducts).mockReturnValue(replicated({ products }));
    await mount();
    expect(screen.getByText(text)).toBeTruthy();
  });

  it('says a held unsupported settings result applies after the sale, not "Offline"', async () => {
    vi.mocked(useReplicatedProducts).mockReturnValue(replicated({ products: [{ id: 'shirt', title: 'Shirt', status: 'published',
      variants: [{ id: 'blue', title: 'Blue', sku: 'BLUE', prices: [{ amount: 12, currency_code: 'eur' }] }] }] }));
    const view = await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Shirt' }));
    vi.mocked(useStoreSettings).mockReturnValue({ state: 'unsupported' });
    await act(async () => { view.rerender(<SessionProvider><ProductsScreen /></SessionProvider>); });
    expect(screen.getByText('Store settings changed; this applies after the current sale')).toBeTruthy();
    expect(screen.queryByText('Offline')).toBeNull();
    expect(screen.getByText('Shirt: €12.00 × 1 = €12.00')).toBeTruthy();
  });

  it('shows the outbox status and attention count and pushes Orders without replacing the route', async () => {
    const order = savedSale();
    vi.mocked(useOutboxContext).mockReturnValue({ ...useOutboxContext(),
      state: { pending: 2, sending: true }, recent: [order, { ...order, id: 'rejected', syncStatus: 'rejected' },
        { ...order, id: 'warned', syncStatus: 'applied', warnings: [{ code: 'total_mismatch', serverMinor: 1000, expectedMinor: 1200 }] }],
    });
    await mount();
    expect(screen.getByLabelText('2 sales waiting to sync').textContent).toBe('2 sales waiting to sync');
    expect(screen.getByText('Sending…')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Orders (2)' }));
    expect(router.push).toHaveBeenCalledExactlyOnceWith('/orders');
    expect(router.replace).not.toHaveBeenCalled();
  });

  it.each([undefined, 'Alex Shopkeeper'])('records the cashier email and shows the receipt with name %s', async (name) => {
    vi.mocked(useReplicatedProducts).mockReturnValue(replicated({ products: [{
      id: 'shirt', title: 'Shirt', status: 'published', variants: [{ id: 'blue', title: 'Blue', sku: 'BLUE',
        prices: [{ amount: 12, currency_code: 'eur' }] }],
    }] }));
    await mount(true, false, name);
    fireEvent.click(screen.getByRole('button', { name: 'Shirt' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Card terminal' })); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Payment approved on terminal' })); });
    expect(useOutboxContext().record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      syncStatus: 'pending', totalMinor: 1500, cashierRef: 'admin@store.test',
    }));
    expect(screen.getByRole('button', { name: 'Print receipt' })).toBeTruthy();
    expect(screen.getByText(`Cashier: ${name ?? 'admin@store.test'}`)).toBeTruthy();
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function mount(signedIn = true, orders = false, name?: string) {
  if (signedIn) saveSession(localStorage, {
    baseUrl: 'https://store.test', email: 'admin@store.test', name,
    token: `header.${btoa(JSON.stringify({ exp: Date.now() / 1000 + 86400 }))}.signature`,
  });
  let view!: ReturnType<typeof render>;
  await act(async () => { view = render(<SessionProvider>{orders ? <OrdersScreen /> : <ProductsScreen />}</SessionProvider>); });
  return view;
}

function savedSale(): PosOrder {
  const builder = createOrderBuilder({ currency: 'EUR', taxContext: { pricesIncludeTax: false, getTaxRatePpm: () => 0 } });
  builder.addLine({ productId: 'shirt', variantId: 'blue', name: 'Blue shirt', unitPrice: { amount: 1200, currency: 'EUR' } });
  builder.addPayment({ method: 'cash', amountMinor: 1200 });
  return finalizeOrder(builder.getSnapshot());
}

describe('Orders screen and sync status', () => {
  it('shows only Recent when no orders need attention', async () => {
    const order = savedSale();
    vi.mocked(useOutboxContext).mockReturnValue({ ...useOutboxContext(), recent: [
      order, { ...order, id: 'applied', syncStatus: 'applied', warnings: [] },
    ] });
    await mount(true, true);
    expect(screen.getAllByRole('heading').map((heading) => heading.textContent)).toEqual(['Recent']);
    expect(screen.getByRole('link', { name: 'Send feedback' })).toBeTruthy();
  });
  it('lists attention first, including errors, both warnings, totals and server display IDs', async () => {
    const order = savedSale();
    vi.mocked(useOutboxContext).mockReturnValue({ ...useOutboxContext(), recent: [
      { ...order, id: 'rejected', syncStatus: 'rejected', error: { code: 'invalid', message: 'Unknown variant' } },
      { ...order, id: 'warned', syncStatus: 'applied', serverRefs: { orderId: 'server', displayId: '42', totalMinor: 1000 },
        lines: order.lines.map((line) => ({ ...line, quantity: 3 })),
        warnings: [{ code: 'insufficient_stock', variantId: 'blue', quantity: 2 },
          { code: 'total_mismatch', serverMinor: 1000, expectedMinor: 1200 }] }, order,
    ] });
    await mount(true, true);
    expect(screen.getAllByRole('heading').map((heading) => heading.textContent)).toEqual(['Needs attention', 'Recent']);
    for (const label of ["The online store refused this sale. Ask the store owner to look at the till's sync log.", 'Stock short by 2 for Blue shirt', 'Store total €10.00 vs POS €12.00', 'Order #42 · 3 items']) {
      expect(screen.getAllByText(label)).toHaveLength(2);
    }
    expect(screen.getAllByText('1 item')).toHaveLength(3);
    const dateAndTotal = `${new Date(order.createdAt).toLocaleString()} · €12.00`;
    expect(screen.getByText(`${dateAndTotal} · Waiting to sync`)).toBeTruthy();
    expect(screen.getAllByText(`${dateAndTotal} · Synced`)).toHaveLength(2);
    expect(screen.getAllByText(`${dateAndTotal} · Not accepted`)).toHaveLength(2);
  });

  it.each(['invalid', 'idempotency_mismatch', 'warnings'])('offers Retry only for requeueable rejections: %s', async (kind) => {
    const order = savedSale();
    const recent: PosOrder[] = [kind === 'warnings'
      ? { ...order, syncStatus: 'applied', warnings: [{ code: 'total_mismatch', serverMinor: 1000, expectedMinor: 1200 }] }
      : { ...order, syncStatus: 'rejected', error: { code: kind, message: 'Rejected' } }];
    const requeue = vi.fn().mockResolvedValue(1);
    vi.mocked(useOutboxContext).mockReturnValue({ ...useOutboxContext(), recent, requeue });
    await mount(true, true);
    if (kind === 'invalid') {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      expect(requeue).toHaveBeenCalledExactlyOnceWith([order.id]);
    } else {
      expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
      expect(requeue).not.toHaveBeenCalled();
    }
    // In both Needs attention and Recent (#314).
    expect(screen.queryAllByText("The online store has a different sale under this sale's number. Don't send it again; ask the store owner to compare the two."))
      .toHaveLength(kind === 'idempotency_mismatch' ? 2 : 0);
  });

  it.each([0, 1])('blocks repeat Retry taps until requeue resolves %s or the order leaves rejected', async (result) => {
    const order: PosOrder = { ...savedSale(), syncStatus: 'rejected' };
    let resolve!: (count: number) => void;
    const requeue = vi.fn(() => new Promise<number>((done) => { resolve = done; }));
    vi.mocked(useOutboxContext).mockReturnValue({ ...useOutboxContext(), recent: [order], requeue });
    await mount(true, true);
    const retry = screen.getByRole('button', { name: 'Retry' });
    act(() => { fireEvent.click(retry); fireEvent.click(retry); });
    expect(requeue).toHaveBeenCalledExactlyOnceWith([order.id]);
    expect(retry.getAttribute('aria-disabled')).toBe('true');
    await act(async () => { resolve(result); });
    expect(retry.getAttribute('aria-disabled')).toBe(result === 0 ? null : 'true');
    fireEvent.click(retry);
    expect(requeue).toHaveBeenCalledTimes(result === 0 ? 2 : 1);
  });

  it.each(['pending', 'applied'] as const)('clears Retry state when the outbox reports %s', async (syncStatus) => {
    const order: PosOrder = { ...savedSale(), syncStatus: 'rejected' };
    const requeue = vi.fn().mockResolvedValue(1);
    vi.mocked(useOutboxContext).mockReturnValue({ ...useOutboxContext(), recent: [order], requeue });
    const view = await mount(true, true);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    vi.mocked(useOutboxContext).mockReturnValue({ ...useOutboxContext(), recent: [{ ...order, syncStatus }] });
    view.rerender(<SessionProvider><OrdersScreen /></SessionProvider>);
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    vi.mocked(useOutboxContext).mockReturnValue({ ...useOutboxContext(), recent: [order] });
    view.rerender(<SessionProvider><OrdersScreen /></SessionProvider>);
    expect(screen.getByRole('button', { name: 'Retry' }).getAttribute('aria-disabled')).toBeNull();
  });

  it('redirects Orders to login when signed out', async () => {
    await mount(false, true);
    expect(screen.getByText('redirect:/login')).toBeTruthy();
    expect(screen.queryByText('Recent')).toBeNull();
  });

  it('shows retry seconds and updates the countdown', () => {
    vi.useFakeTimers();
    try {
      render(<SyncStatus state={{ pending: 1, sending: false, lastRetryReason: 'network', nextAttemptAt: Date.now() + 3000 }} />);
      expect(screen.getByLabelText('1 sale waiting to sync').textContent).toBe('1 sale waiting to sync');
      expect(screen.getByText('Retrying in 3 s.')).toBeTruthy();
      act(() => { vi.advanceTimersByTime(1000); });
      expect(screen.getByText('Retrying in 2 s.')).toBeTruthy();
      expect(screen.queryByText('Retrying in 3 s.')).toBeNull();
      cleanup();
    } finally { vi.useRealTimers(); }
  });
});

describe('ProductsScreen live stock', () => {
  const item = (id: string, stocked: number) => ({ inventory_item_id: id, required_quantity: 1,
    inventory: { location_levels: [{ stocked_quantity: stocked, reserved_quantity: 0 }] } });
  const shirt = { id: 'shirt', title: 'Shirt', status: 'published', variants: [
    { id: 'small', title: 'Small', sku: 'S', prices: [], manage_inventory: true, inventory_items: [item('inv-small', 0)] },
    { id: 'large', title: 'Large', sku: 'L', prices: [], manage_inventory: true, inventory_items: [item('inv-large', 4)] },
  ] };

  it('reads stock from the overlay before the replicated product', async () => {
    const pass = new Date('2026-09-24T10:42:00Z');
    vi.mocked(useReplicatedProducts).mockReturnValue(replicated({ products: [shirt], lastSyncedAt: new Date(0),
      lastStockCheckAt: pass, stockOverlay: new Map([
        ['inv-small', [{ stocked_quantity: 3, reserved_quantity: 0 }]],
        ['inv-large', [{ stocked_quantity: 2, reserved_quantity: 2 }]],
      ]) }));
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Shirt' }));
    const asOf = `as of ${formatStockSyncTime(pass)}`;
    expect(screen.getByRole('button', { name: /Small/ }).textContent).toContain(`In Stock · ${asOf}`);
    expect(screen.getByRole('button', { name: /Large/ }).textContent).toContain(`Out of Stock · ${asOf}`);
  });

  it('reconciles stock once for each applied order with a new insufficient_stock warning', async () => {
    const short: PosOrder = { ...savedSale(), syncStatus: 'applied',
      warnings: [{ code: 'insufficient_stock', variantId: 'blue', quantity: 2 }] };
    const outbox = useOutboxContext();
    vi.mocked(useOutboxContext).mockReturnValue({ ...outbox, recent: [short, { ...short, id: 'queued', syncStatus: 'pending' }] });
    const view = await mount();
    expect(reconcileStock).toHaveBeenCalledTimes(1);
    vi.mocked(useOutboxContext).mockReturnValue({ ...outbox, recent: [{ ...short }] });
    view.rerender(<SessionProvider><ProductsScreen /></SessionProvider>);
    expect(reconcileStock).toHaveBeenCalledTimes(1);
  });
});

describe('ProductsScreen sale layout (ADR 0009)', () => {
  const button = (name: string | RegExp) => screen.getByRole('button', { name });
  const search = () => screen.queryByPlaceholderText('Search or scan barcode / SKU');
  beforeEach(() => { vi.mocked(useReplicatedProducts).mockReturnValue(replicated({ products: [{ id: 'shirt', title: 'Shirt',
    status: 'published', variants: [{ id: 'blue', title: 'Blue', sku: 'BLUE', prices: [{ amount: 12, currency_code: 'eur' }] }] }] })); });

  it('at 360 wide adds stay on Products, the bar opens the cart, Products returns, and tender and new sale take over', async () => {
    setWindowWidth(360);
    await mount();
    expect(button('Cart is empty').getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(button('Shirt'));
    expect(button('Open cart, 1 item, €15.00').textContent).toBe('Cart · 1 item€15.00 ›');
    fireEvent.click(button('Shirt'));
    expect(button('Open cart, 2 items, €30.00').textContent).toBe('Cart · 2 items€30.00 ›');
    expect(search()).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cash' })).toBeNull();
    fireEvent.click(button(/^Open cart/));
    expect(screen.getByText('Shirt: €12.00 × 2 = €24.00')).toBeTruthy();
    expect(search()).toBeNull();
    fireEvent.click(button('Products'));
    expect(search()).toBeTruthy();
    fireEvent.click(button('Open cart, 2 items, €30.00'));
    expect(screen.getByText('Shirt: €12.00 × 2 = €24.00')).toBeTruthy();
    await act(async () => { fireEvent.click(button('Cash')); });
    expect(button('Complete sale')).toBeTruthy();
    for (const name of ['Products', /^Open cart/, 'Cash']) expect(screen.queryByRole('button', { name })).toBeNull();
    expect(search()).toBeNull();
    fireEvent.click(button('Back'));
    await act(async () => { fireEvent.click(button('Card terminal')); });
    await act(async () => { fireEvent.click(button('Payment approved on terminal')); });
    fireEvent.click(button('New sale'));
    expect(button('Cart is empty')).toBeTruthy();
    expect(search()).toBeTruthy();
  }, 15000);

  it('at 1280 wide shows the catalogue and cart with no bar; the order discount scrolls and pay is pinned', async () => {
    await mount();
    fireEvent.click(button('Shirt'));
    expect(search()).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Open cart|^Cart is empty$/ })).toBeNull();
    // CartPanel's scroll region isn't a separate testID; the Order discount button comes after the last line instead.
    const lastLine = screen.getByText('Shirt: €12.00 × 1 = €12.00');
    const orderDiscount = screen.getByRole('button', { name: 'Order discount' });
    expect(lastLine.compareDocumentPosition(orderDiscount) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const footer = within(screen.getByTestId('cart-footer'));
    for (const name of ['Cash', 'Card terminal']) expect(footer.getByRole('button', { name })).toBeTruthy();
    expect(footer.getByText('Total: €15.00')).toBeTruthy();
  });
});

describe('ProductsScreen session routing', () => {
  it('redirects to login without a session', async () => {
    await mount(false);
    expect(screen.getByText('redirect:/login')).toBeTruthy();
    expect(useReplicatedProducts).not.toHaveBeenCalled();
  });
  it('clears the session and redirects to login when Sign out is pressed', async () => {
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(localStorage.getItem('medusapos.session')).toBeNull();
    // The screen's own <Redirect href="/login">, with no extra navigation.
    expect(screen.getByText('redirect:/login')).toBeTruthy();
    expect(router.replace).not.toHaveBeenCalled();
  });
  it('signs out when product replication reports unauthorized', async () => {
    await mount();
    const [, context, onUnauthorized] = vi.mocked(useReplicatedProducts).mock.calls[0];
    expect({ ...context.headers }).toEqual({ Authorization: 'Bearer ' + JSON.parse(localStorage.getItem('medusapos.session')!).token });
    expect(context).toMatchObject({ connectorId: 'medusa', baseUrl: 'https://store.test', pricingContext: pricing.pricingContext });
    act(() => onUnauthorized());
    expect(localStorage.getItem('medusapos.session')).toBeNull();
    expect(screen.getByText('redirect:/login')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
  });
});

// Sign out unmounts the sale and closes the outbox, so it waits for a pending save (the #150 review).
// outbox.test.tsx covers the same lock on the real outbox.
describe('ProductsScreen Sign out while a sale is saving', () => {
  const SALE_SAVING = 'This sale is being saved. Retry to finish it.';
  beforeEach(() => { vi.mocked(useReplicatedProducts).mockReturnValue(replicated({ products: [{ id: 'shirt', title: 'Shirt',
    status: 'published', variants: [{ id: 'blue', title: 'Blue', sku: 'BLUE', prices: [{ amount: 12, currency_code: 'eur' }] }] }] })); });
  const signedOut = () => localStorage.getItem('medusapos.session') === null;

  it.each(['stored', 'continue'] as const)('is disabled with the lock message during a held save and does nothing, then works once the save settles (%s)', async (settles) => {
    let save!: () => void;
    let fail!: (error: Error) => void;
    const record = vi.fn(() => new Promise<void>((resolve, reject) => { save = resolve; fail = reject; }));
    const isStored = vi.fn().mockResolvedValue(settles === 'continue');
    vi.mocked(useOutboxContext).mockReturnValue({ ...useOutboxContext(), record, isStored });
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Shirt' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Card terminal' })); });
    expect(screen.getByRole('button', { name: 'Sign out' }).getAttribute('aria-disabled')).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Payment approved on terminal' })); });
    expect(record).toHaveBeenCalledTimes(1);

    // Held: disabled in place, described by the tender's lock message, and a press signs nothing out.
    const signOut = screen.getByRole('button', { name: 'Sign out', description: SALE_SAVING });
    expect(signOut.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getAllByRole('button').slice(0, 3).map((button) => button.textContent)).toEqual(['Orders', 'Settings', 'Sign out']);
    fireEvent.click(signOut);
    expect(signedOut()).toBe(false);
    expect(router.replace).not.toHaveBeenCalled();
    expect(screen.queryByText('redirect:/login')).toBeNull();
    // Orders and Settings stay live: they push onto the stack, over the mounted sale.
    fireEvent.click(screen.getByRole('button', { name: 'Orders' }));
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(vi.mocked(router.push).mock.calls).toEqual([['/orders'], ['/settings']]);

    if (settles === 'stored') {
      await act(async () => { save(); });
      expect(screen.getByRole('button', { name: 'Print receipt' })).toBeTruthy();
    } else {
      await act(async () => { fail(new Error('Storage full')); });
      const continueButton = await screen.findByRole('button', { name: 'Continue' });
      expect(isStored).toHaveBeenCalledTimes(1);
      // Confirmed stored, but still locked until Continue is pressed.
      expect(screen.getByRole('button', { name: 'Sign out' }).getAttribute('aria-disabled')).toBe('true');
      fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
      expect(signedOut()).toBe(false);
      fireEvent.click(continueButton);
      expect(screen.getByText('Scan or tap a product to start a sale.')).toBeTruthy();
    }
    const unlocked = screen.getByRole('button', { name: 'Sign out' });
    expect(unlocked.getAttribute('aria-disabled')).toBeNull();
    expect(screen.queryByText(SALE_SAVING)).toBeNull();
    fireEvent.click(unlocked);
    expect(signedOut()).toBe(true);
    expect(screen.getByText('redirect:/login')).toBeTruthy();
  });

  // The central sale hold (ADR 0015): an automatic sign-out also waits for the receipt to clear.
  it('defers a replication 401 during a held save; the receipt shows and stays, and it signs out once after New sale', async () => {
    let save!: () => void;
    const record = vi.fn(() => new Promise<void>((resolve) => { save = resolve; }));
    vi.mocked(useOutboxContext).mockReturnValue({ ...useOutboxContext(), record });
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Shirt' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Card terminal' })); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Payment approved on terminal' })); });
    // Replication reports 401 twice while the save is held: nothing signs out or navigates.
    const onUnauthorized = vi.mocked(useReplicatedProducts).mock.lastCall![2];
    act(() => { onUnauthorized(); onUnauthorized(); });
    expect(signedOut()).toBe(false);
    expect(screen.queryByText('redirect:/login')).toBeNull();
    expect(screen.getByText('Signed out after this sale is saved')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Payment approved on terminal' })).toBeTruthy();

    await act(async () => { save(); });
    expect(screen.getByRole('button', { name: 'Print receipt' })).toBeTruthy();
    expect(signedOut()).toBe(false);
    // On the receipt, no earlier save: the wording says New sale, not "Signed out after this sale is saved" (#86 review, item 2).
    expect(screen.queryByText('Signed out after this sale is saved')).toBeNull();
    expect(screen.getByText('You\'ll be signed out when you start a new sale.')).toBeTruthy();
    expect(clearProductCache).not.toHaveBeenCalled();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'New sale' })); });
    expect(signedOut()).toBe(true);
    expect(screen.getByText('redirect:/login')).toBeTruthy();
    expect(screen.queryByText('You\'ll be signed out when you start a new sale.')).toBeNull();
    expect(clearProductCache).toHaveBeenCalledTimes(1);
  });

  it('stays disabled after a failed save that is not confirmed stored, until Retry stores it', async () => {
    const record = vi.fn().mockRejectedValueOnce(new Error('Storage full')).mockResolvedValue(undefined);
    vi.mocked(useOutboxContext).mockReturnValue({ ...useOutboxContext(), record, isStored: vi.fn().mockResolvedValue(false) });
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Shirt' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Card terminal' })); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Payment approved on terminal' })); });
    expect(screen.getByRole('alert').textContent).toBe('The sale could not be saved: Storage full');
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(signedOut()).toBe(false);
    expect(router.replace).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Payment approved on terminal' })); });
    expect(screen.getByRole('button', { name: 'Print receipt' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(signedOut()).toBe(true);
  });

  // TallyUI #161: while a save is in flight and unconfirmed, useSale re-asks isStored every 5 s (HUNG_SAVE_CHECK_MS),
  // through this app's own wiring (no hungSaveCheckMs). The outbox record doesn't settle until the test settles it: a
  // hung insert. The real SessionProvider and OutboxProvider hold sign-out on it, over a stand-in for TallyUI's
  // useOrderOutbox whose savesInFlight counts its record calls not yet settled, as TallyUI's does (#163).
  let settle: { resolve: () => void; reject: (error: Error) => void };
  let hungSession: ReturnType<typeof useSession>;
  let hungOutbox: ReturnType<typeof useOutboxContext>;
  function HungSessionProbe() { hungSession = useSession(); return null; }
  function HungOutboxProbe() { hungOutbox = useOutboxContext(); return null; }
  const hungTree = () => <SessionProvider><HungSessionProbe />
    <OutboxProvider><HungOutboxProbe /><ProductsScreen /></OutboxProvider></SessionProvider>;
  let hungView: ReturnType<typeof render>;
  async function hungSale(isStored: (order: PosOrder) => Promise<boolean>) {
    const record = vi.fn((_order: PosOrder) => new Promise<void>((resolve, reject) => { settle = { resolve, reject }; }));
    vi.mocked(useOrderOutbox).mockImplementation(function useHungOutbox() {
      const [savesInFlight, setSavesInFlight] = useState(0);
      // Not null: these tests are about the hung-save mechanics, not the order-store-open gate (#86 review, item 5).
      return { orders: {} as never, state: { pending: 0, sending: false }, recent: [], savesInFlight, stuckCommandIds: [], isStored,
        flush: vi.fn().mockResolvedValue(undefined), requeue: vi.fn().mockResolvedValue(0),
        async record(order: PosOrder) {
          setSavesInFlight((count) => count + 1);
          try { await record(order); } finally { setSavesInFlight((count) => count - 1); }
        } };
    });
    vi.mocked(useOutboxContext).mockImplementation(realOutbox.useOutboxContext);
    saveSession(localStorage, { baseUrl: 'https://store.test', email: 'admin@store.test',
      token: `header.${btoa(JSON.stringify({ exp: Date.now() / 1000 + 86400 }))}.signature` });
    await act(async () => { hungView = render(hungTree()); });
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Shirt' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Card terminal' })); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Payment approved on terminal' })); });
    expect(record).toHaveBeenCalledTimes(1);
    return record.mock.calls[0][0];
  }
  const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  const signOutDisabled = () => screen.getByRole('button', { name: 'Sign out' }).getAttribute('aria-disabled');
  /** Continue on a hung save confirmed stored at the first 5 s check: the new sale shows, Sign out waits for the old save. */
  async function continuePastHungSave() {
    await advance(5000);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText('Scan or tap a product to start a sale.')).toBeTruthy();
    const signOut = screen.getByRole('button', { name: 'Sign out', description: EARLIER_SALE_SAVING });
    expect(signOut.getAttribute('aria-disabled')).toBe('true');
    expect(screen.queryByText(SALE_SAVING)).toBeNull();
    fireEvent.click(signOut);
    expect(signedOut()).toBe(false);
    expect(screen.queryByText('redirect:/login')).toBeNull();
  }

  it('offers Continue with no tap once a hung save is confirmed stored; Continue starts a new sale, and Sign out waits for that save', async () => {
    const isStored = vi.fn<(order: PosOrder) => Promise<boolean>>().mockResolvedValueOnce(false).mockResolvedValue(true);
    try {
      const saved = await hungSale(isStored);
      await advance(4999);
      expect(isStored).not.toHaveBeenCalled();
      expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
      expect(signOutDisabled()).toBe('true');
      // The first check, at 5 s, answers not stored yet; the next, at 10 s, confirms it.
      await advance(1);
      expect(isStored).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
      await advance(5000);
      expect(isStored).toHaveBeenCalledTimes(2);
      expect(isStored).toHaveBeenLastCalledWith(saved);
      const continueButton = screen.getByRole('button', { name: 'Continue' });
      // Confirmed stored, but still locked until Continue is pressed.
      expect(signOutDisabled()).toBe('true');
      fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
      expect(signedOut()).toBe(false);
      fireEvent.click(continueButton);
      expect(screen.getByText('Scan or tap a product to start a sale.')).toBeTruthy();
      // The #85 review: the abandoned save is still in flight, and RxDB's close would wait on it, so Sign out stays
      // locked, described as an earlier sale's. The next sale isn't held.
      expect(screen.getByRole('button', { name: 'Sign out', description: EARLIER_SALE_SAVING }).getAttribute('aria-disabled')).toBe('true');
      expect(screen.queryByText(SALE_SAVING)).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
      expect(signedOut()).toBe(false);
      fireEvent.click(screen.getByRole('button', { name: 'Shirt' }));
      expect(screen.getByText('Shirt: €12.00 × 1 = €12.00')).toBeTruthy();
      // The poll has stopped.
      await advance(15000);
      expect(isStored).toHaveBeenCalledTimes(2);
      expect(signOutDisabled()).toBe('true');
      // Once the old save settles, Sign out is released and works.
      await act(async () => { settle.resolve(); });
      expect(signOutDisabled()).toBeNull();
      expect(screen.queryByText(EARLIER_SALE_SAVING)).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
      expect(signedOut()).toBe(true);
      expect(screen.getByText('redirect:/login')).toBeTruthy();
      cleanup();
    } finally { vi.useRealTimers(); }
  });

  it('keeps a deferred 401 pending past Continue while the abandoned hung save is in flight, then signs out once it settles', async () => {
    try {
      await hungSale(vi.fn().mockResolvedValue(true));
      act(() => { vi.mocked(useReplicatedProducts).mock.lastCall![2](); });
      expect(screen.getByText('Signed out after this sale is saved')).toBeTruthy();
      await continuePastHungSave();
      expect(clearProductCache).not.toHaveBeenCalled();
      await advance(15000);
      expect(signedOut()).toBe(false);
      await act(async () => { settle.resolve(); });
      expect(signedOut()).toBe(true);
      expect(screen.getByText('redirect:/login')).toBeTruthy();
      expect(clearProductCache).toHaveBeenCalledTimes(1);
      cleanup();
    } finally { vi.useRealTimers(); }
  });

  it('releases Sign out when the abandoned hung save rejects late, after Continue', async () => {
    try {
      await hungSale(vi.fn().mockResolvedValue(true));
      await continuePastHungSave();
      await act(async () => { settle.reject(new Error('Storage full')); });
      // The new sale carries on, with no error from the old one.
      expect(screen.getByText('Scan or tap a product to start a sale.')).toBeTruthy();
      expect(screen.queryByText(/could not be saved/)).toBeNull();
      expect(signOutDisabled()).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
      expect(signedOut()).toBe(true);
      cleanup();
    } finally { vi.useRealTimers(); }
  });

  it('offers no Continue while a hung save is never confirmed stored, and Sign out stays locked', async () => {
    const isStored = vi.fn<(order: PosOrder) => Promise<boolean>>().mockResolvedValue(false);
    try {
      await hungSale(isStored);
      await advance(15000);
      expect(isStored).toHaveBeenCalledTimes(3);
      expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Payment approved on terminal' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Sign out', description: SALE_SAVING }).getAttribute('aria-disabled')).toBe('true');
      fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
      expect(signedOut()).toBe(false);
      expect(screen.queryByText('redirect:/login')).toBeNull();
      cleanup();
    } finally { vi.useRealTimers(); }
  });

  // (d) The #85 re-review's gap: store settings that unmount the sale screen after Continue release its sale hold, but
  // the saves hold is OutboxProvider's, so an automatic sign-out still waits for the abandoned save.
  it('keeps an automatic sign-out waiting on the abandoned hung save after store settings unmount the sale, then signs out once it settles', async () => {
    try {
      await hungSale(vi.fn().mockResolvedValue(true));
      await continuePastHungSave();
      vi.mocked(useStoreSettings).mockReturnValue({ state: 'unsupported' });
      await act(async () => { hungView.rerender(hungTree()); });
      expect(screen.getByText('This backend can\'t supply store settings')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
      // (g) #86 review, item 1: the earlier-sale note shows above the settings screen too, not only the sale screen.
      expect(screen.getByText(EARLIER_SALE_SAVING)).toBeTruthy();
      act(() => { hungSession.reportUnauthorized(); });
      expect(hungOutbox.savesInFlight).toBe(1);
      expect(hungSession.signOutDeferred).toBe(true);
      expect(signedOut()).toBe(false);
      expect(screen.getByText('An earlier sale is still being saved. You\'ll be signed out once it\'s saved.')).toBeTruthy();
      await advance(15000);
      expect(hungOutbox.savesInFlight).toBe(1);
      expect(signedOut()).toBe(false);
      expect(screen.queryByText('redirect:/login')).toBeNull();
      expect(clearProductCache).not.toHaveBeenCalled();

      await act(async () => { settle.resolve(); });
      expect(hungOutbox.savesInFlight).toBe(0);
      expect(signedOut()).toBe(true);
      expect(screen.getByText('redirect:/login')).toBeTruthy();
      expect(clearProductCache).toHaveBeenCalledTimes(1);
      cleanup();
    } finally { vi.useRealTimers(); }
  });

  // (e) Sign out's lock, shown: the visible note under the header, not the hidden description (#sign-out-locked).
  it.each(['without', 'with'] as const)('shows why Sign out is locked after Continue on a hung save (%s a deferred 401) until the save settles', async (deferred) => {
    const DEFERRED_NOTE = 'An earlier sale is still being saved. You\'ll be signed out once it\'s saved.';
    const visible = (text: string) => screen.queryByText(text, { ignore: '#sign-out-locked, script, style' });
    try {
      await hungSale(vi.fn().mockResolvedValue(true));
      expect(visible(EARLIER_SALE_SAVING)).toBeNull();
      await continuePastHungSave();
      expect(visible(EARLIER_SALE_SAVING)!.closest('[data-print="hide"]')).toBeTruthy();
      expect(visible(DEFERRED_NOTE)).toBeNull();
      expect(screen.queryByText('Signed out after this sale is saved')).toBeNull();
      if (deferred === 'with') {
        act(() => { hungSession.reportUnauthorized(); });
        expect(visible(EARLIER_SALE_SAVING)).toBeNull();
        expect(visible(DEFERRED_NOTE)).toBeTruthy();
        expect(screen.queryByText('Signed out after this sale is saved')).toBeNull();
      }
      // The accessible description is unchanged.
      expect(screen.getByRole('button', { name: 'Sign out', description: EARLIER_SALE_SAVING })).toBeTruthy();

      await act(async () => { settle.resolve(); });
      expect(visible(EARLIER_SALE_SAVING)).toBeNull();
      expect(visible(DEFERRED_NOTE)).toBeNull();
      expect(signedOut()).toBe(deferred === 'with');
      if (deferred === 'without') expect(signOutDisabled()).toBeNull();
      cleanup();
    } finally { vi.useRealTimers(); }
  });
});

// Settings → Scanner's minChars is the Products search's minCodeLength (ADR 0016, TallyUI #148).
describe('ProductsScreen search minCodeLength', () => {
  beforeEach(() => { vi.mocked(useReplicatedProducts).mockReturnValue(replicated({ products: [{ id: 'shirt', title: 'Shirt',
    status: 'published', variants: [{ id: 'blue', title: 'Blue', sku: 'AB123', prices: [{ amount: 12, currency_code: 'eur' }] }] }] })); });

  it.each([[6, false], [3, true]])('with minChars %i, Enter on the 5-character code "AB123" adds the product: %s', async (minChars, adds) => {
    saveScannerSettings(localStorage, 'https://store.test', { avgKeyMs: 100, minChars });
    await mount();
    const search = screen.getByPlaceholderText('Search or scan barcode / SKU') as HTMLInputElement;
    fireEvent.change(search, { target: { value: 'AB123' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    if (adds) {
      expect(screen.getByText('Shirt: €12.00 × 1 = €12.00')).toBeTruthy();
      expect(search.value).toBe('');
    } else {
      // No code lookup: the text stays a search, still showing its match, and the cart stays empty.
      expect(screen.queryByText(/× 1 =/)).toBeNull();
      expect(screen.getByText('Scan or tap a product to start a sale.')).toBeTruthy();
      expect(search.value).toBe('AB123');
      expect(screen.getByRole('button', { name: 'Shirt' })).toBeTruthy();
    }
  });
});

// The #82 review: every sign-out path honours SessionProvider's sale hold, through the real provider and screen.
describe('ProductsScreen: every sign-out waits for a saving sale', () => {
  const NOTE = 'Signed out after this sale is saved';
  const jwt = (exp: number) => `header.${btoa(JSON.stringify({ exp }))}.signature`;
  const inADay = () => jwt(Math.floor(Date.now() / 1000) + 86400);
  let context: ReturnType<typeof useSession>;
  function SessionProbe() { context = useSession(); return null; }
  let reject!: (error: Error) => void;
  const held = () => new Promise<never>((_resolve, fail) => { reject = fail; });
  const signedIn = () => localStorage.getItem('medusapos.session') !== null;
  const button = (name: string) => screen.getByRole('button', { name });
  beforeEach(() => { vi.mocked(useReplicatedProducts).mockReturnValue(replicated({ products: [{ id: 'shirt', title: 'Shirt',
    status: 'published', variants: [{ id: 'blue', title: 'Blue', sku: 'BLUE', prices: [{ amount: 12, currency_code: 'eur' }] }] }] })); });
  afterEach(() => { vi.mocked(refreshSession).mockReset(); vi.mocked(login).mockReset(); });

  it('builds a new connector for each store session and keeps it for the whole session', async () => {
    saveSession(localStorage, { baseUrl: 'https://store.test', email: 'admin@store.test', token: inADay() });
    let view!: ReturnType<typeof render>;
    await act(async () => { view = render(<SessionProvider><SessionProbe /><ProductsScreen /></SessionProvider>); });
    const a = vi.mocked(useReplicatedProducts).mock.lastCall![0];

    await act(async () => { view.rerender(<SessionProvider><SessionProbe /><ProductsScreen /></SessionProvider>); });
    expect(vi.mocked(useReplicatedProducts).mock.lastCall![0]).toBe(a);
    const renewed = jwt(Math.floor(Date.now() / 1000) + 2 * 86400);
    vi.mocked(login).mockResolvedValue({ baseUrl: 'https://store.test', email: 'admin@store.test', token: renewed });
    await act(async () => { await context.signIn('https://store.test', 'admin@store.test', 'password'); });
    expect(context.session?.token).toBe(renewed);
    expect(vi.mocked(useReplicatedProducts).mock.lastCall![0]).toBe(a);

    act(() => { context.signOut(); });
    expect(screen.getByText('redirect:/login')).toBeTruthy();
    await act(async () => { await context.signIn('https://store.test', 'admin@store.test', 'password'); });
    const b = vi.mocked(useReplicatedProducts).mock.lastCall![0];
    expect(b).not.toBe(a);
  });

  async function mountTill(token = inADay()) {
    saveSession(localStorage, { baseUrl: 'https://store.test', email: 'admin@store.test', token });
    await act(async () => { render(<SessionProvider><SessionProbe /><ProductsScreen /></SessionProvider>); });
  }
  it('resumes a stopped product pull after the session is renewed in place, never on mount', async () => {
    const resumePull = vi.fn();
    vi.mocked(useReplicatedProducts).mockReturnValue(replicated({
      pullNotice: { code: 'unauthorized', since: 0, fixedBy: 'till' }, resumePull,
    }));
    await mountTill();
    expect(resumePull).not.toHaveBeenCalled();
    const renewed = jwt(Math.floor(Date.now() / 1000) + 2 * 86400);
    vi.mocked(login).mockResolvedValue({ baseUrl: 'https://store.test', email: 'admin@store.test', token: renewed });
    await act(async () => { await context.signIn('https://store.test', 'admin@store.test', 'password'); });
    expect(context.session?.token).toBe(renewed);
    expect(resumePull).toHaveBeenCalledTimes(1);
  });

  /** Tenders the shirt by card; the first save fails and isn't stored, the retry stores it. */
  async function failedSave(token?: string) {
    const record = vi.fn().mockRejectedValueOnce(new Error('Storage full')).mockResolvedValue(undefined);
    vi.mocked(useOutboxContext).mockReturnValue({ ...useOutboxContext(), record, isStored: vi.fn().mockResolvedValue(false) });
    await mountTill(token);
    fireEvent.click(button('Shirt'));
    await act(async () => { fireEvent.click(button('Card terminal')); });
    await act(async () => { fireEvent.click(button('Payment approved on terminal')); });
    expect(screen.getByRole('alert').textContent).toBe('The sale could not be saved: Storage full');
  }

  const paths: Record<string, { token?: () => string; arm?: () => void; request: () => void }> = {
    // Disabled while saving (a press does nothing); the request it would make is the context's signOut.
    'the Sign out button': { request: () => { fireEvent.click(button('Sign out')); context.signOut(); } },
    'a product replication 401': { request: () => vi.mocked(useReplicatedProducts).mock.lastCall![2]() },
    'the capabilities check': {
      arm: () => { capabilities.mockImplementation(held); },
      request: () => reject(new SignInError('invalid_credentials', 'Token expired', 401)),
    },
    'the store-settings fetch': {
      arm: () => { vi.mocked(fetchStoreSettings).mockImplementation(held); },
      request: () => reject(new StoreSettingsError('unauthorized', 'Please sign in again.')),
    },
    'a refresh refused with invalid_credentials': {
      token: () => jwt(Math.floor(Date.now() / 1000) + 3600),
      arm: () => { vi.mocked(refreshSession).mockImplementation(held); },
      request: () => reject(new LoginError('invalid_credentials', 'Token expired')),
    },
  };

  it.each(Object.keys(paths))('%s: deferred during a failed save, then signs out once after Retry and New sale', async (name) => {
    const path = paths[name];
    path.arm?.();
    await failedSave(path.token?.());
    await act(async () => { path.request(); });
    // The sale stays mounted on its tender, and the session stays.
    expect(button('Payment approved on terminal')).toBeTruthy();
    expect(signedIn()).toBe(true);
    expect(screen.queryByText('redirect:/login')).toBeNull();
    expect(screen.getByText(NOTE)).toBeTruthy();

    await act(async () => { fireEvent.click(button('Payment approved on terminal')); });
    expect(button('Print receipt')).toBeTruthy();
    expect(signedIn()).toBe(true);
    expect(clearProductCache).not.toHaveBeenCalled();

    await act(async () => { fireEvent.click(button('New sale')); });
    expect(signedIn()).toBe(false);
    expect(screen.getByText('redirect:/login')).toBeTruthy();
    expect(clearProductCache).toHaveBeenCalledTimes(1);
  });

  // The #82 re-review: the sale screen can unmount for other reasons (LiveTabGate's park, a blocking storage prompt).
  // Its release must not run the pending sign-out then; the next mounted sale screen's release does.
  it('keeps a deferred sign-out pending when the sale screen unmounts mid-save, and runs it once a sale screen remounts', async () => {
    const record = vi.fn(() => new Promise<void>(() => {}));
    vi.mocked(useOutboxContext).mockReturnValue({ ...useOutboxContext(), record });
    const Root = ({ sale }: { sale: boolean }) => <SessionProvider><SessionProbe />{sale ? <ProductsScreen /> : null}</SessionProvider>;
    saveSession(localStorage, { baseUrl: 'https://store.test', email: 'admin@store.test', token: inADay() });
    let view!: ReturnType<typeof render>;
    await act(async () => { view = render(<Root sale />); });
    fireEvent.click(button('Shirt'));
    await act(async () => { fireEvent.click(button('Card terminal')); });
    await act(async () => { fireEvent.click(button('Payment approved on terminal')); });
    act(() => { vi.mocked(useReplicatedProducts).mock.lastCall![2](); });
    expect(screen.getByText(NOTE)).toBeTruthy();

    await act(async () => { view.rerender(<Root sale={false} />); });
    expect(signedIn()).toBe(true);
    expect(clearProductCache).not.toHaveBeenCalled();
    expect(context.signOutDeferred).toBe(true);

    await act(async () => { view.rerender(<Root sale />); });
    expect(signedIn()).toBe(false);
    expect(screen.getByText('redirect:/login')).toBeTruthy();
    expect(clearProductCache).toHaveBeenCalledTimes(1);
  });

  it('drops a request deferred under one token once the session is renewed to another, and never signs out', async () => {
    const renewed = jwt(Math.floor(Date.now() / 1000) + 2 * 86400);
    vi.mocked(login).mockResolvedValue({ baseUrl: 'https://store.test', email: 'admin@store.test', token: renewed });
    await failedSave();
    act(() => { vi.mocked(useReplicatedProducts).mock.lastCall![2](); });
    expect(screen.getByText(NOTE)).toBeTruthy();
    // SignInAgain's renewal: the pending request goes, and so does the note.
    await act(async () => { await context.signIn('https://store.test', 'admin@store.test', 'password'); });
    expect(context.session?.token).toBe(renewed);
    expect(screen.queryByText(NOTE)).toBeNull();

    await act(async () => { fireEvent.click(button('Payment approved on terminal')); });
    await act(async () => { fireEvent.click(button('New sale')); });
    expect(signedIn()).toBe(true);
    expect(screen.queryByText('redirect:/login')).toBeNull();
    expect(clearProductCache).not.toHaveBeenCalled();
    expect(screen.getByText('Scan or tap a product to start a sale.')).toBeTruthy();
  });
});

// #86 review, item 2: the earlier-sale note's exact wording, by savesInFlight, sale.saving, signOutDeferred and the receipt stage.
describe('ProductsScreen earlier-sale note wording', () => {
  let context: ReturnType<typeof useSession>;
  function SessionProbe() { context = useSession(); return null; }
  // The hidden Sign out description shares EARLIER_SALE_SAVING's exact text while signOutLocked, so plain-text
  // checks must ignore it (as the hung-save tests above do), or getByText matches both nodes.
  const visible = (text: string) => screen.getByText(text, { ignore: '#sign-out-locked, script, style' });
  beforeEach(() => { vi.mocked(useReplicatedProducts).mockReturnValue(replicated({ products: [{ id: 'shirt', title: 'Shirt',
    status: 'published', variants: [{ id: 'blue', title: 'Blue', sku: 'BLUE', prices: [{ amount: 12, currency_code: 'eur' }] }] }] })); });

  async function arrange(savesInFlight: number, record: (order: PosOrder) => Promise<void>) {
    vi.mocked(useOutboxContext).mockReturnValue({ ...useOutboxContext(), savesInFlight, record });
    saveSession(localStorage, { baseUrl: 'https://store.test', email: 'admin@store.test',
      token: `header.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86400 }))}.signature` });
    await act(async () => { render(<SessionProvider><SessionProbe /><ProductsScreen /></SessionProvider>); });
  }
  async function pay(savesInFlight: number, resolves: boolean) {
    const record = vi.fn<(order: PosOrder) => Promise<void>>();
    await arrange(savesInFlight, resolves ? record.mockResolvedValue(undefined) : record.mockImplementation(() => new Promise(() => {})));
    fireEvent.click(screen.getByRole('button', { name: 'Shirt' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Card terminal' })); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Payment approved on terminal' })); });
  }

  it('shows only the plain note for an earlier save in flight, not deferred', async () => {
    await arrange(1, vi.fn<(order: PosOrder) => Promise<void>>());
    expect(visible(EARLIER_SALE_SAVING)).toBeTruthy();
  });
  it('adds "once it\'s saved" for an earlier save in flight, deferred, off the receipt', async () => {
    await arrange(1, vi.fn<(order: PosOrder) => Promise<void>>());
    act(() => context.setSavesHold(true));
    act(() => context.signOut());
    expect(visible(`${EARLIER_SALE_SAVING} You'll be signed out once it's saved.`)).toBeTruthy();
  });
  it('adds "and you start a new sale" for an earlier save in flight, deferred, on the receipt', async () => {
    await pay(1, true);
    expect(screen.getByRole('button', { name: 'Print receipt' })).toBeTruthy();
    act(() => context.reportUnauthorized());
    expect(visible(`${EARLIER_SALE_SAVING} You'll be signed out once it's saved and you start a new sale.`)).toBeTruthy();
  });
  it('keeps "Signed out after this sale is saved" while this sale itself is saving, with no earlier save', async () => {
    await pay(0, false);
    act(() => context.reportUnauthorized());
    expect(visible('Signed out after this sale is saved')).toBeTruthy();
  });
  it('says the sign-out waits for a new sale on the receipt, with no earlier save', async () => {
    await pay(0, true);
    expect(screen.getByRole('button', { name: 'Print receipt' })).toBeTruthy();
    act(() => context.reportUnauthorized());
    expect(visible('You\'ll be signed out when you start a new sale.')).toBeTruthy();
  });
  it('shows no note with nothing pending', async () => {
    await arrange(0, vi.fn<(order: PosOrder) => Promise<void>>());
    expect(screen.queryByText(/signed out|being saved/i, { ignore: '#sign-out-locked, script, style' })).toBeNull();
  });
});

// #86 review, item 3: the Reload hint, appended to the earlier-sale note once storage reports a stall.
describe('ProductsScreen earlier-sale reload hint', () => {
  const visible = (text: string) => screen.getByText(text, { ignore: '#sign-out-locked, script, style' });
  function drive(status: 'ok' | 'stalled') {
    return watchStorageHealth(new BehaviorSubject<StorageHealthReading>({ status, stalledWrites: status === 'stalled' ? 1 : 0 }));
  }
  it('appends the reload hint once storage reports stalled', async () => {
    const unregister = drive('stalled');
    try {
      vi.mocked(useOutboxContext).mockReturnValue({ ...useOutboxContext(), savesInFlight: 1 });
      await mount();
      expect(visible(`${EARLIER_SALE_SAVING} That sale is already stored; reload if this doesn't clear.`)).toBeTruthy();
    } finally { unregister(); }
  });
  it('shows no hint while storage is ok', async () => {
    const unregister = drive('ok');
    try {
      vi.mocked(useOutboxContext).mockReturnValue({ ...useOutboxContext(), savesInFlight: 1 });
      await mount();
      expect(visible(EARLIER_SALE_SAVING)).toBeTruthy();
      expect(screen.queryByText(/That sale is already stored/)).toBeNull();
    } finally { unregister(); }
  });
});

// #86 review, item 5: paying waits for the order store to open.
describe('ProductsScreen tender gated on the order store opening', () => {
  beforeEach(() => { vi.mocked(useReplicatedProducts).mockReturnValue(replicated({ products: [{ id: 'shirt', title: 'Shirt',
    status: 'published', variants: [{ id: 'blue', title: 'Blue', sku: 'BLUE', prices: [{ amount: 12, currency_code: 'eur' }] }] }] })); });
  it('says it couldn\'t check the register, and logs why, when the check fails for another reason', async () => {
    const fixture = openRegisterFixture();
    vi.mocked(fixture.register.requireSaleSession).mockRejectedValue(new Error('storage went away'));
    vi.mocked(useRegister).mockReturnValue(fixture);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await mount();
      fireEvent.click(screen.getByRole('button', { name: 'Shirt' }));
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cash' })); });
      expect(screen.getByRole('alert').textContent).toBe("Couldn't check the register. Try again.");
      expect(screen.queryByRole('button', { name: 'Complete sale' })).toBeNull();
      expect(warn).toHaveBeenCalledWith('Could not check the register at tender start:', expect.objectContaining({ message: 'storage went away' }));
    } finally { warn.mockRestore(); }
  });

  // While orders is null the register isn't enabled either (its collections are in the same store, ADR 0017).
  it('refuses to start a tender while orders is null, saying so, then tenders once it opens', async () => {
    vi.mocked(useOutboxContext).mockReturnValue({ ...useOutboxContext(), orders: null });
    vi.mocked(useRegister).mockReturnValue(openRegisterFixture({ enabled: false }));
    const view = await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Shirt' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Card terminal' })); });
    expect(screen.getByRole('alert').textContent).toBe('Getting ready to save sales…');
    expect(screen.queryByRole('button', { name: 'Payment approved on terminal' })).toBeNull();
    vi.mocked(useOutboxContext).mockReturnValue({ ...useOutboxContext(), orders: {} as never });
    vi.mocked(useRegister).mockReturnValue(openRegisterFixture());
    await act(async () => { view.rerender(<SessionProvider><ProductsScreen /></SessionProvider>); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Card terminal' })); });
    expect(screen.getByRole('button', { name: 'Payment approved on terminal' })).toBeTruthy();
  });
});
