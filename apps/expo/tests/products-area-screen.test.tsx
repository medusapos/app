// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProductTraits, VariantSummary } from '@tallyui/core';
import type { Session } from '../lib/session';
import { publishCatalogue } from '../lib/catalogue-snapshot';
import { PRODUCTS_ADMIN_NOTE, PRODUCTS_EMPTY, PRODUCTS_NO_MATCH, PRODUCTS_NOT_LOADED } from '../lib/products-area';
import ProductsAreaScreen from '../app/products';

const { sessionState } = vi.hoisted(() => ({ sessionState: { session: null as Session | null } }));
vi.mock('expo-router', () => ({
  Redirect: ({ href }: { href: string }) => <span>redirect:{href}</span>,
  router: { replace: vi.fn(), push: vi.fn(), dismissTo: vi.fn() }, usePathname: () => '/products',
  Stack: { Screen: ({ options }: { options: { headerLeft?: () => ReactNode } }) =>
    <div data-testid="header-left">{options.headerLeft?.()}</div> },
}));
vi.mock('../lib/session-context', () => ({ useSession: () => sessionState }));

type Doc = { id: string; title: string; variants: VariantSummary[]; categories?: { id: string; name: string }[] };
const traits = {
  getName: (doc: Doc) => doc.title,
  getVariantCount: (doc: Doc) => doc.variants.length,
  getVariants: (doc: Doc) => doc.variants,
  getCategories: (doc: Doc) => doc.categories ?? [],
  getCategoryNames: (doc: Doc) => (doc.categories ?? []).map((category) => category.name),
} as unknown as ProductTraits;
const eur = (amount: number) => [{ amount, currency: 'EUR', kind: 'base' as const }];
const products: Doc[] = [
  { id: 'p1', title: 'E2E product 1', variants: [
    { id: 'v1', title: 'Default', sku: 'E2E-1', prices: eur(1000), stock: { status: 'in_stock', quantity: 5 } }] },
  { id: 'p4', title: 'E2E product 4', variants: [
    { id: 'v4a', title: 'A', sku: 'E2E-4', prices: eur(2000), stock: { status: 'in_stock', quantity: 2 } },
    { id: 'v4b', title: 'B', sku: 'E2E-4B', prices: eur(2500), stock: { status: 'backorder' } }] },
];
const session: Session = { baseUrl: 'https://store.test', email: 'admin@store.test', token: 't' };
const mount = () => render(<ProductsAreaScreen />);

afterEach(() => {
  cleanup();
  act(() => publishCatalogue(null));
  sessionState.session = null;
});

describe('ProductsAreaScreen', () => {
  it('redirects to /login with no session', () => {
    mount();
    expect(screen.getByText('redirect:/login')).toBeTruthy();
  });

  it('lists each variant of the published catalogue with name, SKU, price and stock, under the admin note', () => {
    sessionState.session = session;
    publishCatalogue({ baseUrl: session.baseUrl, products, traits, currency: 'EUR' });
    mount();
    expect(screen.getByTestId('products-admin-note').textContent).toBe(PRODUCTS_ADMIN_NOTE);
    expect(screen.getByTestId('products-table')).toBeTruthy();
    const cells = (id: string) => within(screen.getByTestId(`product-row-${id}`)).getAllByText(/./).map((node) => node.textContent);
    expect(cells('v1')).toEqual(['E2E product 1', 'E2E-1', '5', 'In stock', '€10.00']);
    expect(cells('v4a')).toEqual(['E2E product 4 · A', 'E2E-4', '2', 'In stock', '€20.00']);
    expect(cells('v4b')).toEqual(['E2E product 4 · B', 'E2E-4B', 'On backorder', 'On backorder', '€25.00']);
  });

  it('filters to a SKU, and says when nothing matches', () => {
    sessionState.session = session;
    publishCatalogue({ baseUrl: session.baseUrl, products, traits, currency: 'EUR' });
    mount();
    fireEvent.change(screen.getByTestId('products-search'), { target: { value: 'E2E-4B' } });
    expect(Array.from(document.querySelectorAll('[data-testid^="product-row-"]')).map((row) => row.getAttribute('data-testid')))
      .toEqual(['product-row-v4b']);
    fireEvent.change(screen.getByTestId('products-search'), { target: { value: 'hat' } });
    expect(document.querySelector('[data-testid^="product-row-"]')).toBeNull();
    expect(screen.getByText(PRODUCTS_NO_MATCH('hat'))).toBeTruthy();
  });

  it('says the catalogue is empty, not that nothing matches, for an empty catalogue with no search', () => {
    sessionState.session = session;
    publishCatalogue({ baseUrl: session.baseUrl, products: [], traits, currency: 'EUR' });
    mount();
    expect(screen.getByText(PRODUCTS_EMPTY)).toBeTruthy();
    expect(screen.queryByText(/No products match/)).toBeNull();
  });

  it('shows the not-loaded line and no table with no snapshot, or one for another store', () => {
    sessionState.session = session;
    mount();
    expect(screen.getByTestId('products-not-loaded').textContent).toBe(PRODUCTS_NOT_LOADED);
    expect(screen.queryByTestId('products-table')).toBeNull();
    act(() => publishCatalogue({ baseUrl: 'https://other.test', products, traits, currency: 'EUR' }));
    expect(screen.getByTestId('products-not-loaded')).toBeTruthy();
    expect(screen.queryByTestId('products-table')).toBeNull();
    expect(screen.getByTestId('products-admin-note')).toBeTruthy();
  });
});
