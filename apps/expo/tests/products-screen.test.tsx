// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps, ReactNode } from 'react';
import type { ProductCard, ProductGrid, SearchInput, CartPanelProps, CartLineProps, CartTotalProps } from '@tallyui/components';
import { formatMoney } from '@tallyui/core';
import { createOrderBuilder, finalizeOrder, type LineItem, type PosOrder } from '@tallyui/pos';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { router } from 'expo-router';
import { saveSession } from '../lib/session';
import { SessionProvider } from '../lib/session-context';
import { useReplicatedProducts } from '../lib/use-replicated-products';
import { fetchStoreSettings, saveCachedSettings, type StoreSettings } from '../lib/store-settings';
import ProductsScreen from '../app/index';
import OrdersScreen from '../app/orders';
import { useOutboxContext } from '../lib/outbox-context';
import { SyncStatus } from '../components/sync-status';
import { OutboxStrip, StoreRefused } from '../components/store-refused';

vi.mock('expo-router', () => ({
  Redirect: ({ href }: { href: string }) => <span>redirect:{href}</span>,
  router: { replace: vi.fn(), push: vi.fn() },
  Stack: { Screen: ({ options }: { options: { headerRight?: () => ReactNode } }) => options.headerRight?.() },
}));
// expo-localization's native module isn't available under vitest.
vi.mock('expo-localization', () => ({ getCalendars: () => [{ uses24hourClock: null }] }));
vi.mock('../lib/use-replicated-products', () => ({ useReplicatedProducts: vi.fn() }));
vi.mock('../lib/outbox-context', () => ({ useOutboxContext: vi.fn() }));
vi.mock('../lib/product-cache', () => ({ clearProductCache: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../lib/store-settings', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/store-settings')>(), fetchStoreSettings: vi.fn(),
}));
vi.mock('@tallyui/components', () => ({
  CartPanel: ({ items, renderItem, footer, emptyState }: CartPanelProps<LineItem>) =>
    <div>{items.length ? items.map((item, index) => <div key={item.id}>{renderItem(item, index)}</div>) : emptyState}{footer}</div>,
  CartLine: ({ name, quantity, unitPrice, lineTotal }: CartLineProps) =>
    <div>{name}: {formatMoney(unitPrice)} × {quantity} = {formatMoney(lineTotal)}</div>,
  CartTotal: ({ subtotal, total, taxLines }: CartTotalProps) => <div>
    <span>Subtotal: {formatMoney(subtotal)}</span>
    {taxLines?.map((line, index) => <span key={index}>{line.label}: {formatMoney(line.amount)}</span>)}
    <span>Total: {formatMoney(total)}</span>
  </div>,
  ProductGrid: ({ items, renderItem, emptyState, numColumns }: ComponentProps<typeof ProductGrid>) => (
    <div data-testid="product-grid" data-columns={numColumns}>{items.length ? items.map((item, index) => <div key={item.id}>{renderItem(item, index)}</div>) : emptyState}</div>
  ),
  ProductCard: ({ doc, onPress }: ComponentProps<typeof ProductCard>) => <button onClick={onPress}>{doc.title}</button>,
  SearchInput: ({ value, onChangeText, onSubmitEditing, placeholder }: ComponentProps<typeof SearchInput>) => (
    <input value={value} placeholder={placeholder} onChange={(event) => onChangeText(event.target.value)}
      onKeyDown={(event) => { if (event.key === 'Enter') onSubmitEditing?.({} as never); }} />
  ),
}));

const settings: StoreSettings = {
  storeName: 'Test shop', currency: 'EUR', taxRatePpm: 250000, pricesIncludeTax: false,
  location: { id: 'loc', name: 'Main', countryCode: 'dk' },
};
beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  });
  saveCachedSettings(localStorage, 'https://store.test', settings);
  vi.mocked(fetchStoreSettings).mockResolvedValue(settings);
  vi.mocked(useReplicatedProducts).mockReturnValue({ products: [], state: 'synced', error: null, lastSyncedAt: null });
  vi.mocked(useOutboxContext).mockReturnValue({ orders: null, state: { pending: 0, sending: false }, recent: [], record: vi.fn().mockResolvedValue(undefined), flush: vi.fn().mockResolvedValue(undefined), requeue: vi.fn().mockResolvedValue(0) });
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
    vi.mocked(useReplicatedProducts).mockReturnValue({
      products: [product('z', 'Zebra'), product('draft', 'Draft', 'draft'), product('a', 'Apple')],
      state: 'offline', error: 'Failed to fetch', lastSyncedAt: null,
    });
    await mount();
    expect(screen.getByText('MedusaJS · Offline · cached catalogue · 2 products · Failed to fetch')).toBeTruthy();
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(['Orders', 'Sign out', 'Apple', 'Zebra', 'Cash', 'Card terminal']);
    expect(screen.getByLabelText('Sync status').textContent).toBe('All sales synced');
    fireEvent.click(screen.getByRole('button', { name: 'Apple' }));
    expect(screen.getByText('Apple: €12.50 × 1 = €12.50')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('Search or scan barcode / SKU'), { target: { value: 'z' } });
    fireEvent.keyDown(screen.getByPlaceholderText('Search or scan barcode / SKU'), { key: 'Enter' });
    expect(screen.getByText('Zebra: €12.50 × 1 = €12.50')).toBeTruthy();
    expect(screen.getByText('Apple: €12.50 × 1 = €12.50')).toBeTruthy();
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
    vi.mocked(useReplicatedProducts).mockReturnValue({ state: 'synced', error: null, lastSyncedAt: null, products: [{
      id: 'shirt', title: 'Shirt', status: 'published', variants: [{ id: 'blue', title: 'Blue', sku: 'BLUE',
        prices: [{ amount: 12, currency_code: 'eur' }] }],
    }] });
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

describe('ProductsScreen session routing', () => {
  it('redirects to login without a session', async () => {
    await mount(false);
    expect(screen.getByText('redirect:/login')).toBeTruthy();
    expect(useReplicatedProducts).not.toHaveBeenCalled();
  });
  it('clears the session and replaces the route when Sign out is pressed', async () => {
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(localStorage.getItem('medusapos.session')).toBeNull();
    expect(screen.getByText('redirect:/login')).toBeTruthy();
    expect(router.replace).toHaveBeenCalledExactlyOnceWith('/login');
  });
  it('signs out when product replication reports unauthorized', async () => {
    await mount();
    const [, headers, baseUrl, onUnauthorized] = vi.mocked(useReplicatedProducts).mock.calls[0];
    expect(headers).toEqual({ Authorization: 'Bearer ' + JSON.parse(localStorage.getItem('medusapos.session')!).token });
    expect(baseUrl).toBe('https://store.test');
    act(() => onUnauthorized());
    expect(localStorage.getItem('medusapos.session')).toBeNull();
    expect(screen.getByText('redirect:/login')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
  });
});
