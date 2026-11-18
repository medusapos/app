// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StoreSettingsError, type ProductTraits, type StoreSettings as PricingSettings, type VariantSummary } from '@tallyui/core';
import { useStoreSettings } from '@tallyui/pos';
import type { Session } from '../lib/session';
import { publishCatalogue, withdrawCatalogue, type CatalogueSnapshot } from '../lib/catalogue-snapshot';
import {
  PRODUCTS_ADMIN_NOTE, PRODUCTS_EMPTY, PRODUCTS_LOADING, PRODUCTS_NO_MATCH, PRODUCTS_NONE_IN_STOCK, saveProductsAreaCategory,
} from '../lib/products-area';
import { fetchStoreSettings, loadSettingsChoice, type StoreSettings } from '../lib/store-settings';
import { useReplicatedProducts } from '../lib/use-replicated-products';
import { capabilities, storeSettings } from './pos-connector-mock';
import ProductsAreaScreen from '../app/products';
import { AppFrame } from '../components/app-frame';
import { setWindowWidth } from './window-width';

const { sessionState } = vi.hoisted(() => ({ sessionState: {
  session: null as Session | null, signOut: () => {}, reportUnauthorized: () => {}, reportNoPosAccess: () => {},
  mergeCapabilities: () => {},
} }));
vi.mock('expo-router', () => ({
  Redirect: ({ href }: { href: string }) => <span>redirect:{href}</span>,
  router: { replace: vi.fn(), push: vi.fn(), dismissTo: vi.fn() }, usePathname: () => '/products',
  Stack: { Screen: ({ options }: { options: { title?: string; headerShown?: boolean; headerLeft?: () => ReactNode } }) =>
    <div data-testid="header-left" data-header-shown={String(options.headerShown)} data-title={options.title}>
      {options.headerLeft?.()}</div> },
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
  setWindowWidth(1024, 768);
});

afterEach(() => {
  cleanup();
  act(() => { withdrawCatalogue('sale'); withdrawCatalogue('products'); });
  sessionState.session = null;
  vi.unstubAllGlobals();
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

  // Intended (ruling on #414): the catalogue read needs the till's region, channel and location, as the Sale does,
  // so a till with no saved choice is set up here, and the choice is the same per-store one the Sale reads.
  it('sets the till up when opened without the Sale and no saved choice, then reads the catalogue with it', async () => {
    const data = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } });
    const actual = await vi.importActual<typeof import('@tallyui/pos')>('@tallyui/pos');
    vi.mocked(useStoreSettings).mockImplementation(actual.useStoreSettings);
    capabilities.mockResolvedValue({ orderCreate: 3, taxRounding: { granularity: 'per_order', mode: 'half_away_from_zero' } });
    storeSettings.mockReset()
      .mockRejectedValueOnce(new StoreSettingsError('choice_required', 'Choose', { regions: [{ id: 'reg_eu', name: 'Europe' }] }))
      .mockResolvedValueOnce(pricing);
    sessionState.session = session;
    await mountRead();
    expect(await screen.findByText('Set up this till')).toBeTruthy();
    expect(useReplicatedProducts).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('radio', { name: 'Europe' }));
    await act(async () => { fireEvent.click(screen.getByText('Continue')); });
    expect(await screen.findByTestId('products-loading')).toBeTruthy();
    expect(vi.mocked(useReplicatedProducts).mock.lastCall![1])
      .toMatchObject({ baseUrl: session.baseUrl, pricingContext: pricing.pricingContext });
    expect(loadSettingsChoice(localStorage, session.baseUrl)).toEqual({ region: 'reg_eu' });
  });

  const categorized: Doc[] = [
    { ...products[0], categories: [{ id: 'cat_drinks', name: 'Drinks' }] },
    { ...products[1], categories: [{ id: 'cat_food', name: 'Food' }] },
  ];
  const rowIds = () => Array.from(document.querySelectorAll('[data-testid^="product-row-"]'))
    .map((row) => row.getAttribute('data-testid')!.replace('product-row-', '')).sort();
  const press = (testID: string) => fireEvent.click(screen.getByTestId(testID));
  const inStock = () => screen.getByTestId('products-in-stock');
  // This Node's test environment has no working localStorage (as the till-setup case above), so these cases stub one.
  const stubStorage = () => {
    const data = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } });
  };

  it('restores the category chosen in an earlier visit', () => {
    stubStorage();
    sessionState.session = session;
    publishCatalogue(sale({ products: categorized }));
    mount();
    press('category-nav-cat_food');
    cleanup();
    mount();
    expect(screen.getByTestId('category-nav-cat_food').getAttribute('aria-checked')).toBe('true');
    expect(rowIds()).toEqual(['v4a', 'v4b']);
    press('category-nav-');
    cleanup();
    mount();
    expect(screen.getByTestId('category-nav-').getAttribute('aria-checked')).toBe('true');
    expect(rowIds()).toEqual(['v1', 'v4a', 'v4b']);
  });

  it('keeps the choice per store', () => {
    stubStorage();
    saveProductsAreaCategory(localStorage, 'https://other.test', 'cat_food');
    sessionState.session = session;
    publishCatalogue(sale({ products: categorized }));
    mount();
    expect(screen.getByTestId('category-nav-').getAttribute('aria-checked')).toBe('true');
    expect(rowIds()).toEqual(['v1', 'v4a', 'v4b']);
  });

  it('shows All products for a stored category missing from the catalogue', () => {
    stubStorage();
    saveProductsAreaCategory(localStorage, session.baseUrl, 'cat_gone');
    sessionState.session = session;
    publishCatalogue(sale({ products: categorized }));
    mount();
    expect(screen.getByTestId('category-nav-').getAttribute('aria-checked')).toBe('true');
    expect(rowIds()).toEqual(['v1', 'v4a', 'v4b']);
  });

  it('narrows to in-stock rows with the In stock chip, with category and search, and does not keep it', () => {
    stubStorage();
    sessionState.session = session;
    publishCatalogue(sale({ products: categorized }));
    mount();
    expect(inStock().getAttribute('aria-pressed')).toBe('false');
    press('products-in-stock');
    expect(inStock().getAttribute('aria-pressed')).toBe('true');
    expect(rowIds()).toEqual(['v1', 'v4a']);
    press('category-nav-cat_food');
    expect(rowIds()).toEqual(['v4a']);
    fireEvent.change(screen.getByTestId('products-search'), { target: { value: 'E2E-4B' } });
    expect(rowIds()).toEqual([]);
    expect(screen.getByText(PRODUCTS_NO_MATCH('E2E-4B'))).toBeTruthy();
    cleanup();
    mount();
    expect(inStock().getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByTestId('category-nav-cat_food').getAttribute('aria-checked')).toBe('true');
    expect(rowIds()).toEqual(['v4a', 'v4b']);
  });

  it('says nothing is in stock when the In stock chip leaves no row and there is no search', () => {
    sessionState.session = session;
    publishCatalogue(sale({ products: [{ ...products[1], variants: [products[1].variants[1]] }] }));
    mount();
    press('products-in-stock');
    expect(rowIds()).toEqual([]);
    expect(screen.getByText(PRODUCTS_NONE_IN_STOCK)).toBeTruthy();
  });

  it('shows the In stock chip when the catalogue has no categories', () => {
    sessionState.session = session;
    publishCatalogue(sale());
    mount();
    expect(inStock()).toBeTruthy();
    expect(screen.queryByTestId('category-nav-')).toBeNull();
  });

  describe('the footer and card', () => {
    const footer = () => screen.getByTestId('products-footer').textContent;

    it('on a tablet the table sits in a card, with Showing n of m under it', () => {
      sessionState.session = session;
      publishCatalogue(sale());
      mount();
      const card = screen.getByTestId('products-table-card');
      expect(card.contains(screen.getByTestId('products-table'))).toBe(true);
      expect(footer()).toBe('Showing 3 of 3');
      expect(card.contains(screen.getByTestId('products-footer'))).toBe(false);
    });

    it('n follows the search, the category and the In stock chip; m stays the catalogue', () => {
      stubStorage();
      sessionState.session = session;
      publishCatalogue(sale({ products: categorized }));
      mount();
      expect(rowIds()).toHaveLength(3);
      expect(footer()).toBe('Showing 3 of 3');
      press('products-in-stock');
      expect(rowIds()).toHaveLength(2);
      expect(footer()).toBe('Showing 2 of 3');
      press('category-nav-cat_food');
      expect(rowIds()).toHaveLength(1);
      expect(footer()).toBe('Showing 1 of 3');
      fireEvent.change(screen.getByTestId('products-search'), { target: { value: 'E2E-4B' } });
      expect(rowIds()).toHaveLength(0);
      expect(footer()).toBe('Showing 0 of 3');
    });

    it('on a phone the list has the same footer and no card', () => {
      setWindowWidth(390, 844);
      sessionState.session = session;
      publishCatalogue(sale());
      mount();
      expect(screen.getByTestId('products-list')).toBeTruthy();
      expect(screen.queryByTestId('products-table-card')).toBeNull();
      expect(footer()).toBe('Showing 3 of 3');
      fireEvent.change(screen.getByTestId('products-search'), { target: { value: 'E2E-4B' } });
      expect(footer()).toBe('Showing 1 of 3');
    });

    it('no footer while the catalogue loads', () => {
      sessionState.session = session;
      publishCatalogue(sale({ status: 'loading' }));
      mount();
      expect(screen.getByTestId('products-loading')).toBeTruthy();
      expect(screen.queryByTestId('products-footer')).toBeNull();
    });
  });
});

describe('the header', () => {
  it('on a wide window there is no title bar; the main landmark is named Products', () => {
    sessionState.session = session;
    publishCatalogue(sale());
    setWindowWidth(1024, 768);
    render(<AppFrame signedIn><ProductsAreaScreen /></AppFrame>);
    const header = screen.getByTestId('header-left');
    expect(header.dataset.headerShown).toBe('false');
    expect(header.dataset.title).toBe('Products');
    expect(screen.queryByTestId('frame-menu')).toBeNull();
    expect(screen.getByRole('main', { name: 'Products' }).contains(screen.getByTestId('products-search'))).toBe(true);
  });

  it('on a phone the header stays, with the frame\'s Menu', () => {
    sessionState.session = session;
    publishCatalogue(sale());
    setWindowWidth(390, 844);
    render(<AppFrame signedIn><ProductsAreaScreen /></AppFrame>);
    const header = screen.getByTestId('header-left');
    expect(header.dataset.headerShown).toBe('true');
    expect(header.contains(screen.getByTestId('frame-menu'))).toBe(true);
  });
});

describe('on a phone', () => {
  beforeEach(() => setWindowWidth(390, 844));
  const listRows = () => Array.from(document.querySelectorAll('[data-testid^="product-list-row-"]'));
  const listRowIds = () => listRows().map((row) => row.getAttribute('data-testid')!.replace('product-list-row-', ''));
  const texts = (id: string) => within(screen.getByTestId(`product-list-row-${id}`)).getAllByText(/./).map((node) => node.textContent);

  it('lists two-line rows instead of the table, by name ascending', () => {
    sessionState.session = session;
    const reversed = [{ ...products[1], variants: [...products[1].variants].reverse() }, products[0]];
    publishCatalogue(sale({ products: reversed }));
    mount();
    expect(screen.getByTestId('products-list')).toBeTruthy();
    expect(screen.queryByTestId('products-table')).toBeNull();
    expect(listRowIds()).toEqual(['v1', 'v4a', 'v4b']);
    expect(texts('v1')).toEqual(['E2E product 1', 'E2E-1', '€10.00', '5 · In stock']);
    expect(texts('v4b')).toEqual(['E2E product 4 · B', 'E2E-4B', '€25.00', 'On backorder']);
  });

  it('rows open nothing', () => {
    sessionState.session = session;
    publishCatalogue(sale());
    mount();
    expect(listRows()).toHaveLength(3);
    for (const row of listRows()) expect(within(row as HTMLElement).queryAllByRole('button')).toEqual([]);
  });

  it('narrows with the search and the In stock chip, and says when nothing matches', () => {
    sessionState.session = session;
    publishCatalogue(sale());
    mount();
    fireEvent.change(screen.getByTestId('products-search'), { target: { value: 'E2E-4B' } });
    expect(listRowIds()).toEqual(['v4b']);
    fireEvent.change(screen.getByTestId('products-search'), { target: { value: 'hat' } });
    expect(listRowIds()).toEqual([]);
    expect(screen.getByText(PRODUCTS_NO_MATCH('hat'))).toBeTruthy();
    fireEvent.change(screen.getByTestId('products-search'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('products-in-stock'));
    expect(listRowIds()).toEqual(['v1', 'v4a']);
  });

  it('shows the table from 600 px wide', () => {
    sessionState.session = session;
    publishCatalogue(sale());
    setWindowWidth(600, 800);
    mount();
    expect(screen.getByTestId('products-table')).toBeTruthy();
    expect(screen.queryByTestId('products-list')).toBeNull();
  });
});
