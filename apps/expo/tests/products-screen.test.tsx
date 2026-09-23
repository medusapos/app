// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps, ReactNode } from 'react';
import type { ProductCard, ProductGrid, SearchInput, CartPanelProps, CartLineProps, CartTotalProps } from '@tallyui/components';
import { formatMoney } from '@tallyui/core';
import type { LineItem } from '@tallyui/pos';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { router } from 'expo-router';
import { saveSession } from '../lib/session';
import { SessionProvider } from '../lib/session-context';
import { useReplicatedProducts } from '../lib/use-replicated-products';
import { fetchStoreSettings, saveCachedSettings, type StoreSettings } from '../lib/store-settings';
import ProductsScreen from '../app/index';

vi.mock('expo-router', () => ({
  Redirect: ({ href }: { href: string }) => <span>redirect:{href}</span>,
  router: { replace: vi.fn() },
  Stack: { Screen: ({ options }: { options: { headerRight?: () => ReactNode } }) => options.headerRight?.() },
}));
vi.mock('../lib/use-replicated-products', () => ({ useReplicatedProducts: vi.fn() }));
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
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(['Sign out', 'Apple', 'Zebra', 'Cash', 'Card terminal']);
    fireEvent.click(screen.getByRole('button', { name: 'Apple' }));
    expect(screen.getByText('Apple: €12.50 × 1 = €12.50')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('Search or scan barcode / SKU'), { target: { value: 'z' } });
    fireEvent.keyDown(screen.getByPlaceholderText('Search or scan barcode / SKU'), { key: 'Enter' });
    expect(screen.getByText('Zebra: €12.50 × 1 = €12.50')).toBeTruthy();
    expect(screen.getByText('Apple: €12.50 × 1 = €12.50')).toBeTruthy();
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function mount(signedIn = true) {
  if (signedIn) saveSession(localStorage, {
    baseUrl: 'https://store.test', email: 'admin@store.test',
    token: `header.${btoa(JSON.stringify({ exp: Date.now() / 1000 + 86400 }))}.signature`,
  });
  await act(async () => { render(<SessionProvider><ProductsScreen /></SessionProvider>); });
}

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
    const [, , baseUrl, onUnauthorized] = vi.mocked(useReplicatedProducts).mock.calls[0];
    expect(baseUrl).toBe('https://store.test');
    act(() => onUnauthorized());
    expect(localStorage.getItem('medusapos.session')).toBeNull();
    expect(screen.getByText('redirect:/login')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
  });
});
