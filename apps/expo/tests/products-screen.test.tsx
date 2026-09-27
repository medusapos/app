// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentProps, ReactNode } from 'react';
import type { ProductGrid, SearchInput, CartLineProps, CartTotalProps } from '@tallyui/components';
import { formatStockSyncTime, SyncStatus } from '@tallyui/components';
import { formatMoney, SignInError, type StoreSettings as PricingSettings } from '@tallyui/core';
import { createOrderBuilder, finalizeOrder, useOrderOutbox, useStoreSettings, type PosOrder } from '@tallyui/pos';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { router } from 'expo-router';
import { clearProductCache } from '../lib/product-cache';
import { saveScannerSettings } from '../lib/scanner-settings';
import { login, LoginError, refreshSession, saveSession } from '../lib/session';
import { posConnector } from '../lib/pos-connector';
import { SessionProvider, useSession } from '../lib/session-context';
import { useReplicatedProducts } from '../lib/use-replicated-products';
import { fetchStoreSettings, saveCachedSettings, StoreSettingsError, type StoreSettings } from '../lib/store-settings';
import ProductsScreen from '../app/index';
import OrdersScreen from '../app/orders';
import { OutboxProvider, useOutboxContext } from '../lib/outbox-context';
import { OutboxStrip, StoreRefused } from '../components/store-refused';
import { setWindowWidth } from './window-width';

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
  lastSyncedAt: null, stockOverlay: undefined, lastStockCheckAt: null, reconcileStock, unlisted: undefined, ...over });

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
  vi.spyOn(posConnector, 'capabilities').mockResolvedValue(undefined);
  vi.mocked(fetchStoreSettings).mockResolvedValue(settings);
  vi.mocked(useStoreSettings).mockReturnValue({ state: 'ready', settings: pricing });
  vi.mocked(useReplicatedProducts).mockReturnValue(replicated({}));
  vi.mocked(useOutboxContext).mockReturnValue({ orders: null, state: { pending: 0, sending: false }, recent: [], savesInFlight: 0, record: vi.fn().mockResolvedValue(undefined), flush: vi.fn().mockResolvedValue(undefined), requeue: vi.fn().mockResolvedValue(0), isStored: vi.fn().mockResolvedValue(false) });
});

describe('ProductsScreen catalogue', () => {
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
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(['Orders', 'Settings', 'Sign out', 'Apple', 'Zebra', 'Cash', 'Card terminal']);
    expect(screen.getByLabelText('Sync status').textContent).toBe('All sales synced');
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
    expect(screen.getByLabelText('Sync status').textContent).toBe('2 sales waiting to sync · sending');
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
    fireEvent.click(screen.getByRole('button', { name: 'Card terminal' }));
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
    for (const label of ['invalid: Unknown variant', 'Stock short by 2 for Blue shirt', 'Store total €10.00 vs POS €12.00', 'Order #42 · 3 items']) {
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
    expect(screen.queryByText('This sale needs checking against the store before it can be sent again.') !== null).toBe(kind === 'idempotency_mismatch');
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
      expect(screen.getByLabelText('Sync status').textContent).toBe('1 sale waiting to sync · retrying (network) in 3s');
      act(() => { vi.advanceTimersByTime(1000); });
      expect(screen.getByLabelText('Sync status').textContent).toBe('1 sale waiting to sync · retrying (network) in 2s');
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
    fireEvent.click(button('Cash'));
    expect(button('Complete sale')).toBeTruthy();
    for (const name of ['Products', /^Open cart/, 'Cash']) expect(screen.queryByRole('button', { name })).toBeNull();
    expect(search()).toBeNull();
    fireEvent.click(button('Back'));
    fireEvent.click(button('Card terminal'));
    await act(async () => { fireEvent.click(button('Payment approved on terminal')); });
    fireEvent.click(button('New sale'));
    expect(button('Cart is empty')).toBeTruthy();
    expect(search()).toBeTruthy();
  });

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
    fireEvent.click(screen.getByRole('button', { name: 'Card terminal' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Card terminal' }));
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
    expect(screen.getByText('Signed out after this sale is saved')).toBeTruthy();
    expect(clearProductCache).not.toHaveBeenCalled();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'New sale' })); });
    expect(signedOut()).toBe(true);
    expect(screen.getByText('redirect:/login')).toBeTruthy();
    expect(screen.queryByText('Signed out after this sale is saved')).toBeNull();
    expect(clearProductCache).toHaveBeenCalledTimes(1);
  });

  it('stays disabled after a failed save that is not confirmed stored, until Retry stores it', async () => {
    const record = vi.fn().mockRejectedValueOnce(new Error('Storage full')).mockResolvedValue(undefined);
    vi.mocked(useOutboxContext).mockReturnValue({ ...useOutboxContext(), record, isStored: vi.fn().mockResolvedValue(false) });
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Shirt' }));
    fireEvent.click(screen.getByRole('button', { name: 'Card terminal' }));
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
  // hung insert. The real OutboxProvider counts it in flight (#85 review), over a stand-in for TallyUI's useOrderOutbox.
  const EARLIER_SALE_SAVING = 'An earlier sale is still being saved.';
  let settle: { resolve: () => void; reject: (error: Error) => void };
  async function hungSale(isStored: (order: PosOrder) => Promise<boolean>) {
    const record = vi.fn((_order: PosOrder) => new Promise<void>((resolve, reject) => { settle = { resolve, reject }; }));
    vi.mocked(useOrderOutbox).mockReturnValue({ orders: null, state: { pending: 0, sending: false }, recent: [],
      flush: vi.fn().mockResolvedValue(undefined), requeue: vi.fn().mockResolvedValue(0), record, isStored });
    vi.mocked(useOutboxContext).mockImplementation(realOutbox.useOutboxContext);
    saveSession(localStorage, { baseUrl: 'https://store.test', email: 'admin@store.test',
      token: `header.${btoa(JSON.stringify({ exp: Date.now() / 1000 + 86400 }))}.signature` });
    await act(async () => { render(<SessionProvider><OutboxProvider><ProductsScreen /></OutboxProvider></SessionProvider>); });
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Shirt' }));
    fireEvent.click(screen.getByRole('button', { name: 'Card terminal' }));
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

  async function mountTill(token = inADay()) {
    saveSession(localStorage, { baseUrl: 'https://store.test', email: 'admin@store.test', token });
    await act(async () => { render(<SessionProvider><SessionProbe /><ProductsScreen /></SessionProvider>); });
  }
  /** Tenders the shirt by card; the first save fails and isn't stored, the retry stores it. */
  async function failedSave(token?: string) {
    const record = vi.fn().mockRejectedValueOnce(new Error('Storage full')).mockResolvedValue(undefined);
    vi.mocked(useOutboxContext).mockReturnValue({ ...useOutboxContext(), record, isStored: vi.fn().mockResolvedValue(false) });
    await mountTill(token);
    fireEvent.click(button('Shirt'));
    fireEvent.click(button('Card terminal'));
    await act(async () => { fireEvent.click(button('Payment approved on terminal')); });
    expect(screen.getByRole('alert').textContent).toBe('The sale could not be saved: Storage full');
  }

  const paths: Record<string, { token?: () => string; arm?: () => void; request: () => void }> = {
    // Disabled while saving (a press does nothing); the request it would make is the context's signOut.
    'the Sign out button': { request: () => { fireEvent.click(button('Sign out')); context.signOut(); } },
    'a product replication 401': { request: () => vi.mocked(useReplicatedProducts).mock.lastCall![2]() },
    'the capabilities check': {
      arm: () => { vi.mocked(posConnector.capabilities!).mockImplementation(held); },
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
    fireEvent.click(button('Card terminal'));
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
