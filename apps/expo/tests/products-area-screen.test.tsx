// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProductTraits, StoreSettings as PricingSettings, VariantSummary } from '@tallyui/core';
import { useStoreSettings } from '@tallyui/pos';
import type { Session } from '../lib/session';
import { publishCatalogue, withdrawCatalogue, type CatalogueSnapshot } from '../lib/catalogue-snapshot';
import { PRODUCTS_ADMIN_NOTE, PRODUCTS_EMPTY, PRODUCTS_LOADING, PRODUCTS_NO_MATCH } from '../lib/products-area';
import { fetchStoreSettings, type StoreSettings } from '../lib/store-settings';
import { useReplicatedProducts } from '../lib/use-replicated-products';
import { capabilities } from './pos-connector-mock';
import ProductsAreaScreen from '../app/products';

const { sessionState } = vi.hoisted(() => ({ sessionState: {
  session: null as Session | null, signOut: () => {}, reportUnauthorized: () => {}, reportNoPosAccess: () => {},
  mergeCapabilities: () => {},
} }));
vi.mock('expo-router', () => ({
  Redirect: ({ href }: { href: string }) => <span>redirect:{href}</span>,
  router: { replace: vi.fn(), push: vi.fn(), dismissTo: vi.fn() }, usePathname: () => '/products',
  Stack: { Screen: ({ options }: { options: { headerLeft?: () => ReactNode } }) =>
    <div data-testid="header-left">{options.headerLeft?.()}</div> },
}));
vi.mock('../lib/session-context', () => ({ useSession: () => sessionState }));
// The area's own catalogue read goes through the Sale's gate: its connector, store settings and replication, driven per test.
vi.mock('../lib/pos-connector', async (importOriginal) => (await import('./pos-connector-mock')).mockPosConnector(importOriginal));
vi.mock('../lib/use-replicated-products', () => ({ useReplicatedProducts: vi.fn() }));
vi.mock('../lib/outbox-context', () => ({ useOutboxContext: () => ({ savesInFlight: 0 }) }));
vi.mock('@tallyui/pos', async (importOriginal) => ({
  ...await importOriginal<typeof import('@tallyui/pos')>(), useStoreSettings: vi.fn(),
}));
vi.mock('../lib/store-settings', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/store-settings')>(), fetchStoreSettings: vi.fn(),
}));

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
// The same catalogue as Medusa documents, as the area's own read replicates them (the Medusa connector's traits).
const medusaProducts = [
  { id: 'p1', title: 'E2E product 1', status: 'published', variants: [
    { id: 'v1', title: 'Default', sku: 'E2E-1', prices: [{ amount: 10, currency_code: 'eur' }] }] },
];
const session: Session = { baseUrl: 'https://store.test', email: 'admin@store.test', token: 't' };
const sale = (over: Partial<CatalogueSnapshot> = {}): CatalogueSnapshot =>
  ({ owner: 'sale', baseUrl: session.baseUrl, products, traits, currency: 'EUR', status: 'ready', ...over });
const mount = () => render(<ProductsAreaScreen />);
const mountRead = async () => {
  let view!: ReturnType<typeof render>;
  await act(async () => { view = mount(); });
  return view;
};

type Replicated = ReturnType<typeof useReplicatedProducts>;
const replicated = (over: Partial<Replicated>) => ({ products: [], state: 'syncing', error: null, stockOverlay: undefined,
  ...over }) as Replicated;
const settings: StoreSettings = { storeName: 'Test shop', currency: 'EUR', location: { id: 'loc', name: 'Main', countryCode: 'dk' } };
const pricing: PricingSettings = {
  currency: 'EUR', pricesIncludeTax: false, taxRatesPpm: { default: 250000 },
  pricingContext: { region_id: 'reg_eu', currency_code: 'eur', publishable_key: 'pk_1' },
};

beforeEach(() => {
  capabilities.mockResolvedValue(undefined);
  vi.mocked(fetchStoreSettings).mockResolvedValue(settings);
  vi.mocked(useStoreSettings).mockReturnValue({ state: 'ready', settings: pricing, refresh: () => {} });
  vi.mocked(useReplicatedProducts).mockReset();
  vi.mocked(useReplicatedProducts).mockReturnValue(replicated({}));
});

afterEach(() => {
  cleanup();
  act(() => { withdrawCatalogue('sale'); withdrawCatalogue('products'); });
  sessionState.session = null;
});

describe('ProductsAreaScreen', () => {
  it('redirects to /login with no session', () => {
    mount();
    expect(screen.getByText('redirect:/login')).toBeTruthy();
  });

  it('lists each variant of the published catalogue with name, SKU, price and stock, under the admin note', () => {
    sessionState.session = session;
    publishCatalogue(sale());
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
    publishCatalogue(sale());
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
    publishCatalogue(sale({ products: [] }));
    mount();
    expect(screen.getByText(PRODUCTS_EMPTY)).toBeTruthy();
    expect(screen.queryByText(/No products match/)).toBeNull();
  });

  it('starts the catalogue read itself when no Sale catalogue is published', async () => {
    sessionState.session = session;
    const view = await mountRead();
    expect(useReplicatedProducts).toHaveBeenCalled();
    expect(vi.mocked(useReplicatedProducts).mock.calls.at(-1)![1]).toMatchObject({ baseUrl: session.baseUrl });
    expect(within(screen.getByTestId('products-loading')).getByText(PRODUCTS_LOADING)).toBeTruthy();
    expect(screen.queryByTestId('products-table')).toBeNull();
    vi.mocked(useReplicatedProducts).mockReturnValue(replicated({ products: medusaProducts, state: 'synced' }));
    act(() => view.rerender(<ProductsAreaScreen />));
    const cells = within(screen.getByTestId('product-row-v1')).getAllByText(/./).map((node) => node.textContent);
    expect(cells.slice(0, 2)).toEqual(['E2E product 1', 'E2E-1']);
    expect(screen.queryByTestId('products-loading')).toBeNull();
  });

  it('shows the read\'s error with a Retry that restarts the read', async () => {
    sessionState.session = session;
    const failed = replicated({ state: 'error', error: 'Medusa API error: 500' });
    // Each mounted read is one hook instance; a Retry that restarts the read mounts a second one.
    const reads = new Set<object>();
    vi.mocked(useReplicatedProducts).mockImplementation(() => {
      const [instance] = useState(() => ({}));
      reads.add(instance);
      return failed;
    });
    await mountRead();
    expect(screen.getByTestId('products-error').textContent).toBe('Medusa API error: 500');
    expect(reads.size).toBe(1);
    await act(async () => { fireEvent.click(screen.getByTestId('products-retry')); });
    expect(reads.size).toBe(2);
    expect(screen.getByTestId('products-error')).toBeTruthy();
  });

  it('does not start a second read under the Sale\'s catalogue', async () => {
    sessionState.session = session;
    publishCatalogue(sale());
    await mountRead();
    expect(useReplicatedProducts).not.toHaveBeenCalled();
    expect(screen.getByTestId('product-row-v1')).toBeTruthy();
    cleanup();
    act(() => withdrawCatalogue('sale'));

    const view = await mountRead();
    expect(screen.getByTestId('products-loading')).toBeTruthy();
    const calls = vi.mocked(useReplicatedProducts).mock.calls.length;
    act(() => publishCatalogue(sale()));
    act(() => view.rerender(<ProductsAreaScreen />));
    expect(vi.mocked(useReplicatedProducts).mock.calls.length).toBe(calls);
    expect(screen.getByTestId('product-row-v4b')).toBeTruthy();
    expect(screen.queryByTestId('products-loading')).toBeNull();
  });

  it('starts its own read when only another store\'s Sale catalogue is published', async () => {
    sessionState.session = session;
    publishCatalogue(sale({ baseUrl: 'https://other.test' }));
    await mountRead();
    expect(useReplicatedProducts).toHaveBeenCalled();
    expect(screen.getByTestId('products-loading')).toBeTruthy();
    expect(screen.queryByTestId('product-row-v1')).toBeNull();
    expect(screen.getByTestId('products-admin-note')).toBeTruthy();
  });
});
