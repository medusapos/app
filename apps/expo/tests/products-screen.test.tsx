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

vi.mock('expo-router', () => ({
  Redirect: ({ href }: { href: string }) => <span>redirect:{href}</span>,
  router: { replace: vi.fn(), push: vi.fn() },
  Stack: { Screen: ({ options }: { options: { headerRight?: () => ReactNode } }) => options.headerRight?.() },
}));
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
  ProductGrid: ({ items, renderItem, emptyState }: ComponentProps<typeof ProductGrid>) => (
    <div>{items.length ? items.map((item, index) => <div key={item.id}>{renderItem(item, index)}</div>) : emptyState}</div>
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
  vi.mocked(useReplicatedProducts).mockReturnValue({ products: [], state: 'synced', error: null });
  vi.mocked(useOutboxContext).mockReturnValue({ orders: null, state: { pending: 0, sending: false }, recent: [], record: vi.fn().mockResolvedValue(undefined) });
});

describe('ProductsScreen catalogue', () => {
  it('keeps cached sellable products sorted while offline and adds selections to the cart', async () => {
    const product = (id: string, title: string, status = 'published') => ({
      id, title, status, variants: [{ id: `${id}-one`, title: 'One size', sku: id,
        prices: [{ amount: 12.5, currency_code: 'eur' }] }],
    });
    vi.mocked(useReplicatedProducts).mockReturnValue({
      products: [product('z', 'Zebra'), product('draft', 'Draft', 'draft'), product('a', 'Apple')],
      state: 'offline', error: 'Failed to fetch',
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

  it('records the finalized sale through the shared outbox', async () => {
    vi.mocked(useReplicatedProducts).mockReturnValue({ state: 'synced', error: null, products: [{
      id: 'shirt', title: 'Shirt', status: 'published', variants: [{ id: 'blue', title: 'Blue', sku: 'BLUE',
        prices: [{ amount: 12, currency_code: 'eur' }] }],
    }] });
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Shirt' }));
    fireEvent.click(screen.getByRole('button', { name: 'Card terminal' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Payment approved on terminal' })); });
    expect(useOutboxContext().record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      syncStatus: 'pending', totalMinor: 1500, cashierRef: 'admin@store.test',
    }));
    expect(screen.getByRole('button', { name: 'Print receipt' })).toBeTruthy();
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function mount(signedIn = true, orders = false) {
  if (signedIn) saveSession(localStorage, {
    baseUrl: 'https://store.test', email: 'admin@store.test',
    token: `header.${btoa(JSON.stringify({ exp: Date.now() / 1000 + 86400 }))}.signature`,
  });
  await act(async () => { render(<SessionProvider>{orders ? <OrdersScreen /> : <ProductsScreen />}</SessionProvider>); });
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
        warnings: [{ code: 'insufficient_stock', variantId: 'blue', quantity: 2 },
          { code: 'total_mismatch', serverMinor: 1000, expectedMinor: 1200 }] }, order,
    ] });
    await mount(true, true);
    expect(screen.getAllByRole('heading').map((heading) => heading.textContent)).toEqual(['Needs attention', 'Recent']);
    for (const label of ['invalid: Unknown variant', 'Stock short by 2 for Blue shirt', 'Store total €10.00 vs POS €12.00', 'applied · 42']) {
      expect(screen.getAllByText(label)).toHaveLength(2);
    }
    expect(screen.getByText('pending')).toBeTruthy();
    expect(screen.getAllByText(`${new Date(order.createdAt).toLocaleString()} · €12.00`)).toHaveLength(5);
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
