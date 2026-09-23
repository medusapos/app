// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps, ReactNode } from 'react';
import type { ProductCard, ProductGrid, SearchInput } from '@tallyui/components';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { router } from 'expo-router';
import { saveSession } from '../lib/session';
import { SessionProvider } from '../lib/session-context';
import { useReplicatedProducts } from '../lib/use-replicated-products';
import ProductsScreen from '../app/index';

vi.mock('expo-router', () => ({
  Redirect: ({ href }: { href: string }) => <span>redirect:{href}</span>,
  router: { replace: vi.fn() },
  Stack: { Screen: ({ options }: { options: { headerRight?: () => ReactNode } }) => options.headerRight?.() },
}));
vi.mock('../lib/use-replicated-products', () => ({ useReplicatedProducts: vi.fn() }));
vi.mock('../lib/product-cache', () => ({ clearProductCache: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@tallyui/components', () => ({
  ProductGrid: ({ items, renderItem, emptyState }: ComponentProps<typeof ProductGrid>) => (
    <div>{items.length ? items.map((item, index) => <div key={item.id}>{renderItem(item, index)}</div>) : emptyState}</div>
  ),
  ProductCard: ({ doc, onPress }: ComponentProps<typeof ProductCard>) => <button onClick={onPress}>{doc.title}</button>,
  SearchInput: ({ value, onChangeText, onSubmitEditing, placeholder }: ComponentProps<typeof SearchInput>) => (
    <input value={value} placeholder={placeholder} onChange={(event) => onChangeText(event.target.value)}
      onKeyDown={(event) => { if (event.key === 'Enter') onSubmitEditing?.({} as never); }} />
  ),
}));

beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  });
  vi.mocked(useReplicatedProducts).mockReturnValue({ products: [], state: 'synced', error: null });
});

describe('ProductsScreen catalogue', () => {
  it('keeps cached sellable products sorted while offline and displays the last selection', () => {
    const product = (id: string, title: string, status = 'published') => ({
      id, title, status, variants: [{ id: `${id}-one`, title: 'One size', sku: id,
        prices: [{ amount: 12.5, currency_code: 'eur' }] }],
    });
    vi.mocked(useReplicatedProducts).mockReturnValue({
      products: [product('z', 'Zebra'), product('draft', 'Draft', 'draft'), product('a', 'Apple')],
      state: 'offline', error: 'Failed to fetch',
    });
    mount();
    expect(screen.getByText('MedusaJS · Offline · cached catalogue · 2 products · Failed to fetch')).toBeTruthy();
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(['Sign out', 'Apple', 'Zebra']);
    fireEvent.click(screen.getByRole('button', { name: 'Apple' }));
    expect(screen.getByText('Selected: Apple · One size · €12.50')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('Search or scan barcode / SKU'), { target: { value: 'z' } });
    fireEvent.keyDown(screen.getByPlaceholderText('Search or scan barcode / SKU'), { key: 'Enter' });
    expect(screen.getByText('Selected: Zebra · One size · €12.50')).toBeTruthy();
    expect(screen.queryByText('Selected: Apple · One size · €12.50')).toBeNull();
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function mount(signedIn = true) {
  if (signedIn) saveSession(localStorage, {
    baseUrl: 'https://store.test', email: 'admin@store.test',
    token: `header.${btoa(JSON.stringify({ exp: Date.now() / 1000 + 86400 }))}.signature`,
  });
  render(<SessionProvider><ProductsScreen /></SessionProvider>);
}

describe('ProductsScreen session routing', () => {
  it('redirects to login without a session', () => {
    mount(false);
    expect(screen.getByText('redirect:/login')).toBeTruthy();
    expect(useReplicatedProducts).not.toHaveBeenCalled();
  });
  it('clears the session and replaces the route when Sign out is pressed', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(localStorage.getItem('medusapos.session')).toBeNull();
    expect(screen.getByText('redirect:/login')).toBeTruthy();
    expect(router.replace).toHaveBeenCalledExactlyOnceWith('/login');
  });
  it('signs out when product replication reports unauthorized', () => {
    mount();
    const [, , baseUrl, onUnauthorized] = vi.mocked(useReplicatedProducts).mock.calls[0];
    expect(baseUrl).toBe('https://store.test');
    act(() => onUnauthorized());
    expect(localStorage.getItem('medusapos.session')).toBeNull();
    expect(screen.getByText('redirect:/login')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
  });
});
