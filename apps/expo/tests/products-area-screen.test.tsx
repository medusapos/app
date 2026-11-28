// @vitest-environment jsdom
// @ts-expect-error no @types/react-dom in this Expo/React Native app
import { createPortal } from 'react-dom';
import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StoreSettingsError, type ProductTraits, type StoreSettings as PricingSettings, type VariantSummary } from '@tallyui/core';
import { DEFAULT_TILE_FIELDS, ScanHubProvider, useScanHub, useStoreSettings } from '@tallyui/pos';
import { PortalHost } from '@tallyui/primitives';
import type { Session } from '../lib/session';
import { publishCatalogue, withdrawCatalogue, type CatalogueSnapshot } from '../lib/catalogue-snapshot';
import {
  PRODUCTS_NONE_WITH_OPTIONS,
  PRODUCTS_ADMIN_NOTE, PRODUCTS_EMPTY, PRODUCTS_LOADING, PRODUCTS_NO_MATCH, PRODUCTS_NONE_IN_STOCK, PRODUCTS_NONE_ON_SALE,
  PRODUCTS_NONE_IN_COLLECTION, PRODUCTS_NONE_ON_SALE_IN_STOCK, PRODUCTS_NONE_TAGGED, PRODUCTS_ON_SALE_LABEL, PRODUCTS_TAGS_NONE, PRODUCTS_TAGS_SEARCH, saveProductsAreaCategory, saveProductsAreaTag,
} from '../lib/products-area';
import { fetchStoreSettings, loadSettingsChoice, type StoreSettings } from '../lib/store-settings';
import { playScanBeep } from '../lib/scan-beep';
import { DEFAULT_SCANNER_SETTINGS, saveScannerSettings } from '../lib/scanner-settings';
import { useProductSettings } from '../lib/product-settings';
import { useReplicatedProducts } from '../lib/use-replicated-products';
import { capabilities, storeSettings } from './pos-connector-mock';
import ProductsAreaScreen from '../app/products';
import { SCAN_TOAST_MS } from '../components/scan-toast';
import { AppFrame, useFrameAccountPublisher } from '../components/app-frame';
import { setWindowWidth } from './window-width';

const { sessionState } = vi.hoisted(() => ({ sessionState: {
  session: null as Session | null, signOut: () => {}, reportUnauthorized: () => {}, reportNoPosAccess: () => {},
  mergeCapabilities: () => {},
} }));
vi.mock('expo-router', () => ({
  Redirect: ({ href }: { href: string }) => <span>redirect:{href}</span>,
  router: { replace: vi.fn(), push: vi.fn(), dismissTo: vi.fn() }, usePathname: () => '/products',
  Stack: { Screen: ({ options }: { options: { title?: string; headerShown?: boolean; headerLeft?: () => ReactNode; headerRight?: () => ReactNode } }) =>
    <><div data-testid="header-left" data-header-shown={String(options.headerShown)} data-title={options.title}>
      {options.headerLeft?.()}</div>
      {/* The stack draws headerRight only when the header shows, outside the screen's main landmark. */}
      {createPortal(<div data-testid="header-right">{options.headerShown && options.headerRight?.()}</div>, document.body)}</> },
}));

function AccountPublisher({ open }: { open: () => void }) {
  useFrameAccountPublisher({ displayName: 'Dana Cole', initials: 'DC', open });
  return null;
}
vi.mock('../lib/session-context', () => ({ useSession: () => sessionState }));
// The area's own catalogue read goes through the Sale's gate: its connector, store settings and replication, driven per test.
vi.mock('../lib/pos-connector', async (importOriginal) => (await import('./pos-connector-mock')).mockPosConnector(importOriginal));
vi.mock('../lib/use-replicated-products', () => ({ useReplicatedProducts: vi.fn() }));
vi.mock('../lib/outbox-context', () => ({ useOutboxContext: () => ({ savesInFlight: 0 }) }));
vi.mock('../lib/scan-beep', () => ({ playScanBeep: vi.fn() }));
vi.mock('@tallyui/pos', async (importOriginal) => ({
  ...await importOriginal<typeof import('@tallyui/pos')>(), useStoreSettings: vi.fn(),
}));
vi.mock('../lib/store-settings', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/store-settings')>(), fetchStoreSettings: vi.fn(),
}));

type Doc = { id: string; title: string; variants: VariantSummary[]; categories?: { id: string; name: string }[];
  tags?: { id: string; value: string }[] };
const traits = {
  getName: (doc: Doc) => doc.title,
  getVariantCount: (doc: Doc) => doc.variants.length,
  getVariants: (doc: Doc) => doc.variants,
  getCategories: (doc: Doc) => doc.categories ?? [],
  getCategoryNames: (doc: Doc) => (doc.categories ?? []).map((category) => category.name),
  getImageUrl: () => undefined,
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

// The tests that press p4's toggle expecting sub-rows run on Expanded rows: storage holding the Sale's Variations
// choice 'popover' for the store (a new device is on Open in place, as the Variations choice tests show).
const EXPANDED_ROWS = ['medusapos.product-settings.https://store.test', JSON.stringify({ variations: 'popover' })] as const;
const stubExpandedRows = () => {
  const data = new Map<string, string>([EXPANDED_ROWS]);
  vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } });
};

beforeEach(() => {
  stubExpandedRows();
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
    press('product-variations-p4');
    expect(cells('v4a')).toEqual(['A', 'E2E-4', '2', 'In stock', '€20.00']);
    expect(cells('v4b')).toEqual(['B', 'E2E-4B', 'On backorder', 'On backorder', '€25.00']);
  });

  it('filters to a SKU, and says when nothing matches', () => {
    sessionState.session = session;
    publishCatalogue(sale());
    mount();
    fireEvent.change(screen.getByTestId('products-search'), { target: { value: 'E2E-4B' } });
    expect(Array.from(document.querySelectorAll('[data-testid^="product-row-"]')).map((row) => row.getAttribute('data-testid')))
      .toEqual(['product-row-p4', 'product-row-v4b']);
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
    press('product-variations-p4');
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
  // This Node's test environment has no working localStorage (as the till-setup case above), so these cases stub one,
  // on Expanded rows.
  const stubStorage = stubExpandedRows;

  it('restores the category chosen in an earlier visit', () => {
    stubStorage();
    sessionState.session = session;
    publishCatalogue(sale({ products: categorized }));
    mount();
    press('category-nav-cat_food');
    cleanup();
    mount();
    expect(screen.getByTestId('category-nav-cat_food').getAttribute('aria-checked')).toBe('true');
    press('product-variations-p4');
    expect(rowIds()).toEqual(['p4', 'v4a', 'v4b']);
    press('category-nav-');
    cleanup();
    mount();
    expect(screen.getByTestId('category-nav-').getAttribute('aria-checked')).toBe('true');
    press('product-variations-p4');
    expect(rowIds()).toEqual(['p4', 'v1', 'v4a', 'v4b']);
  });

  it('keeps the choice per store', () => {
    stubStorage();
    saveProductsAreaCategory(localStorage, 'https://other.test', 'cat_food');
    sessionState.session = session;
    publishCatalogue(sale({ products: categorized }));
    mount();
    expect(screen.getByTestId('category-nav-').getAttribute('aria-checked')).toBe('true');
    press('product-variations-p4');
    expect(rowIds()).toEqual(['p4', 'v1', 'v4a', 'v4b']);
  });

  it('shows All products for a stored category missing from the catalogue', () => {
    stubStorage();
    saveProductsAreaCategory(localStorage, session.baseUrl, 'cat_gone');
    sessionState.session = session;
    publishCatalogue(sale({ products: categorized }));
    mount();
    expect(screen.getByTestId('category-nav-').getAttribute('aria-checked')).toBe('true');
    press('product-variations-p4');
    expect(rowIds()).toEqual(['p4', 'v1', 'v4a', 'v4b']);
  });

  it('narrows to in-stock rows with the In stock chip, with category and search, and does not keep it', () => {
    stubStorage();
    sessionState.session = session;
    publishCatalogue(sale({ products: categorized }));
    mount();
    expect(inStock().getAttribute('aria-pressed')).toBe('false');
    press('products-in-stock');
    expect(inStock().getAttribute('aria-pressed')).toBe('true');
    press('product-variations-p4');
    expect(rowIds()).toEqual(['p4', 'v1', 'v4a']);
    press('category-nav-cat_food');
    expect(rowIds()).toEqual(['p4', 'v4a']);
    fireEvent.change(screen.getByTestId('products-search'), { target: { value: 'E2E-4B' } });
    expect(rowIds()).toEqual([]);
    expect(screen.getByText(PRODUCTS_NO_MATCH('E2E-4B'))).toBeTruthy();
    cleanup();
    mount();
    expect(inStock().getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByTestId('category-nav-cat_food').getAttribute('aria-checked')).toBe('true');
    press('product-variations-p4');
    expect(rowIds()).toEqual(['p4', 'v4a', 'v4b']);
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
      expect(screen.getByTestId('products-settings-button')).toBeTruthy();
    });

    it('n follows the search, the category and the In stock chip; m stays the catalogue', () => {
      stubStorage();
      sessionState.session = session;
      publishCatalogue(sale({ products: categorized }));
      mount();
      press('product-variations-p4');
      expect(rowIds()).toHaveLength(4);
      expect(footer()).toBe('Showing 3 of 3');
      press('products-in-stock');
      expect(rowIds()).toHaveLength(3);
      expect(footer()).toBe('Showing 2 of 3');
      press('category-nav-cat_food');
      expect(rowIds()).toHaveLength(2);
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

  // v2's footer ends with the catalogue sync arrow, after "Showing n of m"; it acts on the catalogue the screen shows.
  describe('the footer sync icon', () => {
    const footer = () => screen.getByTestId('products-footer');

    it('on a tablet the arrow follows Showing n of m in the footer and a tap syncs the Sale\'s catalogue', () => {
      const sync = vi.fn();
      const clearAndRefresh = vi.fn();
      sessionState.session = session;
      publishCatalogue(sale({ sync, clearAndRefresh }));
      mount();
      const button = screen.getByTestId('catalogue-sync');
      expect(footer().contains(button)).toBe(true);
      expect(screen.getByText('Showing 3 of 3').compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(footer().textContent).toBe('Showing 3 of 3');
      fireEvent.click(button);
      expect(sync).toHaveBeenCalledTimes(1);
      expect(clearAndRefresh).not.toHaveBeenCalled();
    });

    it('on a phone the footer has the arrow too', () => {
      setWindowWidth(390, 844);
      const sync = vi.fn();
      sessionState.session = session;
      publishCatalogue(sale({ sync, clearAndRefresh: vi.fn() }));
      mount();
      const button = screen.getByTestId('catalogue-sync');
      expect(footer().contains(button)).toBe(true);
      fireEvent.click(button);
      expect(sync).toHaveBeenCalledTimes(1);
    });

    it('on the screen\'s own read it syncs that read; Clear and Refresh also empties the search and turns In stock off', async () => {
      const syncNow = vi.fn();
      const clearAndRefresh = vi.fn();
      vi.mocked(useReplicatedProducts).mockReturnValue(replicated({ products: medusaProducts, state: 'synced', syncNow, clearAndRefresh }));
      sessionState.session = session;
      // The menu renders in a portal.
      await act(async () => { render(<><ProductsAreaScreen /><PortalHost /></>); });
      fireEvent.click(screen.getByTestId('catalogue-sync'));
      expect(syncNow).toHaveBeenCalledTimes(1);
      fireEvent.change(screen.getByTestId('products-search'), { target: { value: 'E2E' } });
      fireEvent.click(screen.getByTestId('products-in-stock'));
      expect(screen.getByTestId('products-in-stock').getAttribute('aria-pressed')).toBe('true');
      fireEvent.contextMenu(screen.getByTestId('catalogue-sync'));
      fireEvent.click(screen.getByTestId('catalogue-clear-refresh'));
      expect(clearAndRefresh).toHaveBeenCalledTimes(1);
      expect((screen.getByTestId('products-search') as HTMLInputElement).value).toBe('');
      expect(screen.getByTestId('products-in-stock').getAttribute('aria-pressed')).toBe('false');
    });

    it('no arrow for a catalogue published without sync and Clear and Refresh', () => {
      sessionState.session = session;
      publishCatalogue(sale());
      mount();
      expect(footer().textContent).toBe('Showing 3 of 3');
      expect(within(footer()).queryByTestId('catalogue-sync')).toBeNull();
    });
  });

  // v2's Tags pill, by Medusa product tags: one tag at a time, its value on the chip with a cross, kept per store.
  describe('the Tags chip', () => {
    const organic = { id: 'tag_organic', value: 'Organic' };
    const seasonal = { id: 'tag_seasonal', value: 'Seasonal' };
    const tagged: Doc[] = [
      { ...categorized[0], tags: [organic] },
      { ...categorized[1], tags: [seasonal] },
      { id: 'p5', title: 'E2E product 5', categories: [{ id: 'cat_food', name: 'Food' }], tags: [seasonal, organic], variants: [
        { id: 'v5', title: 'Default', sku: 'E2E-5', prices: eur(500), stock: { status: 'out_of_stock', quantity: 0 } }] },
    ];
    // The tag list renders in a portal.
    const mountTags = () => render(<><ProductsAreaScreen /><PortalHost /></>);
    const chip = () => screen.getByTestId('products-tags');
    const footer = () => screen.getByTestId('products-footer').textContent;
    const menuIds = () => Array.from(within(screen.getByTestId('products-tags-menu')).queryAllByRole('radio'))
      .map((item) => item.getAttribute('data-testid'));
    const pick = (tag: { id: string }) => {
      press('products-tags');
      press(`products-tag-${tag.id}`);
    };

    it('on a tablet lists the catalogue\'s tags sorted, and a picked tag narrows the rows and shows on the chip', () => {
      stubStorage();
      sessionState.session = session;
      publishCatalogue(sale({ products: tagged }));
      mountTags();
      expect(chip().textContent).toBe('Tags');
      expect(chip().getAttribute('aria-label')).toBe('Tags');
      expect(screen.queryByTestId('products-tags-menu')).toBeNull();
      press('products-tags');
      expect(menuIds()).toEqual(['products-tag-tag_organic', 'products-tag-tag_seasonal']);
      expect(screen.getByTestId('products-tag-tag_organic').getAttribute('aria-checked')).toBe('false');
      press('products-tag-tag_organic');
      expect(screen.queryByTestId('products-tags-menu')).toBeNull();
      expect(rowIds()).toEqual(['v1', 'v5']);
      expect(chip().textContent).toBe('Organic');
      expect(chip().getAttribute('aria-label')).toBe('Tag: Organic');
      expect(footer()).toBe('Showing 2 of 4');
      press('products-tags');
      expect(screen.getByTestId('products-tag-tag_organic').getAttribute('aria-checked')).toBe('true');
      press('products-tag-tag_seasonal');
      press('product-variations-p4');
      expect(rowIds()).toEqual(['p4', 'v4a', 'v4b', 'v5']);
      expect(chip().textContent).toBe('Seasonal');
      expect(footer()).toBe('Showing 3 of 4');
    });

    it('the search box narrows the tag list, says when no tag matches, and is empty again on the next opening', () => {
      sessionState.session = session;
      publishCatalogue(sale({ products: tagged }));
      mountTags();
      press('products-tags');
      const search = () => screen.getByTestId('products-tags-search') as HTMLInputElement;
      expect(search().getAttribute('placeholder')).toBe(PRODUCTS_TAGS_SEARCH);
      fireEvent.change(search(), { target: { value: ' SEA ' } });
      expect(menuIds()).toEqual(['products-tag-tag_seasonal']);
      fireEvent.change(search(), { target: { value: 'hat' } });
      expect(menuIds()).toEqual([]);
      expect(within(screen.getByTestId('products-tags-menu')).getByText(PRODUCTS_TAGS_NONE)).toBeTruthy();
      press('products-tags');
      expect(screen.queryByTestId('products-tags-menu')).toBeNull();
      press('products-tags');
      expect(search().value).toBe('');
      expect(menuIds()).toHaveLength(2);
    });

    it('narrows together with the category, In stock and the search', () => {
      stubStorage();
      sessionState.session = session;
      publishCatalogue(sale({ products: tagged }));
      mountTags();
      pick(seasonal);
      press('category-nav-cat_drinks');
      expect(rowIds()).toEqual([]);
      expect(screen.getByText(PRODUCTS_NONE_TAGGED('Seasonal'))).toBeTruthy();
      press('category-nav-cat_food');
      press('product-variations-p4');
      expect(rowIds()).toEqual(['p4', 'v4a', 'v4b', 'v5']);
      press('products-in-stock');
      expect(rowIds()).toEqual(['p4', 'v4a']);
      expect(footer()).toBe('Showing 1 of 4');
      fireEvent.change(screen.getByTestId('products-search'), { target: { value: 'E2E-5' } });
      expect(rowIds()).toEqual([]);
      expect(screen.getByText(PRODUCTS_NO_MATCH('E2E-5'))).toBeTruthy();
    });

    it('the cross takes the tag off without opening the list', () => {
      stubStorage();
      sessionState.session = session;
      publishCatalogue(sale({ products: tagged }));
      mountTags();
      expect(screen.queryByTestId('products-tags-remove')).toBeNull();
      pick(organic);
      expect(rowIds()).toEqual(['v1', 'v5']);
      expect(screen.getByTestId('products-tags-remove').getAttribute('aria-label')).toBe('Remove tag');
      press('products-tags-remove');
      press('product-variations-p4');
      expect(rowIds()).toEqual(['p4', 'v1', 'v4a', 'v4b', 'v5']);
      expect(chip().textContent).toBe('Tags');
      expect(screen.queryByTestId('products-tags-remove')).toBeNull();
      expect(screen.queryByTestId('products-tags-menu')).toBeNull();
    });

    it('restores the chosen tag on a new mount, per store, and counts a stored tag gone from the catalogue as none', () => {
      stubStorage();
      sessionState.session = session;
      publishCatalogue(sale({ products: tagged }));
      mountTags();
      pick(organic);
      cleanup();
      mountTags();
      expect(chip().textContent).toBe('Organic');
      expect(rowIds()).toEqual(['v1', 'v5']);
      cleanup();
      stubStorage();
      saveProductsAreaTag(localStorage, 'https://other.test', 'tag_organic');
      mountTags();
      expect(chip().textContent).toBe('Tags');
      press('product-variations-p4');
      expect(rowIds()).toEqual(['p4', 'v1', 'v4a', 'v4b', 'v5']);
      cleanup();
      saveProductsAreaTag(localStorage, session.baseUrl, 'tag_gone');
      mountTags();
      expect(chip().textContent).toBe('Tags');
      press('product-variations-p4');
      expect(rowIds()).toEqual(['p4', 'v1', 'v4a', 'v4b', 'v5']);
      expect(footer()).toBe('Showing 4 of 4');
    });

    it('no Tags chip when the catalogue has no tags', () => {
      sessionState.session = session;
      publishCatalogue(sale({ products: categorized }));
      mountTags();
      expect(inStock()).toBeTruthy();
      expect(screen.queryByTestId('products-tags')).toBeNull();
    });

    it('on a phone the chip shows and narrows the two-line list', () => {
      setWindowWidth(390, 844);
      stubStorage();
      sessionState.session = session;
      publishCatalogue(sale({ products: tagged }));
      mountTags();
      pick(organic);
      expect(Array.from(document.querySelectorAll('[data-testid^="product-list-row-"]'))
        .map((row) => row.getAttribute('data-testid'))).toEqual(['product-list-row-v1', 'product-list-row-v5']);
    });

    it('Clear and Refresh keeps the chosen tag', () => {
      stubStorage();
      const clearAndRefresh = vi.fn();
      sessionState.session = session;
      publishCatalogue(sale({ products: tagged, sync: vi.fn(), clearAndRefresh }));
      mountTags();
      pick(organic);
      fireEvent.contextMenu(screen.getByTestId('catalogue-sync'));
      fireEvent.click(screen.getByTestId('catalogue-clear-refresh'));
      expect(clearAndRefresh).toHaveBeenCalledTimes(1);
      expect(chip().textContent).toBe('Organic');
      expect(rowIds()).toEqual(['v1', 'v5']);
    });
  });

  // v2's Collections pill, by Medusa product collections: titles read from the store API, one at a time, not kept.
  describe('the Collections chip', () => {
    const organic = { id: 'tag_organic', value: 'Organic' };
    const seasonal = { id: 'tag_seasonal', value: 'Seasonal' };
    const inStockVariant = (id: string, sku: string) => [{ id, title: 'Default', sku, prices: eur(700), stock: { status: 'in_stock' as const, quantity: 1 } }];
    // Featured: p1 (in stock, Drinks) and p5 (out of stock, Food); Summer: p4; p6 has none; p7's collection has no title.
    const collected: (Doc & { collection_id?: string })[] = [
      { ...categorized[0], tags: [organic], collection_id: 'pcol_featured' },
      { ...categorized[1], tags: [seasonal], collection_id: 'pcol_summer' },
      { id: 'p5', title: 'E2E product 5', categories: [{ id: 'cat_food', name: 'Food' }], tags: [seasonal, organic],
        collection_id: 'pcol_featured', variants: [
          { id: 'v5', title: 'Default', sku: 'E2E-5', prices: eur(500), stock: { status: 'out_of_stock', quantity: 0 } }] },
      { id: 'p6', title: 'E2E product 6', variants: inStockVariant('v6', 'E2E-6') },
      { id: 'p7', title: 'E2E product 7', collection_id: 'pcol_untitled', variants: inStockVariant('v7', 'E2E-7') },
    ];
    // Storage on Expanded rows with the store's cached pricing (its publishable key) unless `cached` is false, and a
    // fetch answering the store's collections with `status`.
    const stub = ({ cached = true, status = 200 } = {}) => {
      const data = new Map<string, string>([EXPANDED_ROWS]);
      if (cached) data.set(`medusapos.pricing.${session.baseUrl}`, JSON.stringify(pricing));
      vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null,
        setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } });
      const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => !String(input).includes('/store/collections')
        ? new Response('{}', { status: 404 })
        : status === 200 ? new Response(JSON.stringify({ collections: [{ id: 'pcol_featured', title: 'Featured' },
          { id: 'pcol_summer', title: 'Summer' }] }), { status: 200 }) : new Response('{}', { status }));
      vi.stubGlobal('fetch', fetchMock);
      return fetchMock;
    };
    const collectionReads = (fetchMock: ReturnType<typeof stub>) =>
      fetchMock.mock.calls.filter(([input]) => String(input).includes('/store/collections'));
    // The collection list renders in a portal; the chip shows once the titles are read.
    const mountCollections = async () => {
      await act(async () => { render(<><ProductsAreaScreen /><PortalHost /></>); });
    };
    const chip = () => screen.getByTestId('products-collections');
    const footer = () => screen.getByTestId('products-footer').textContent;
    const menuIds = () => Array.from(within(screen.getByTestId('products-collections-menu')).queryAllByRole('radio'))
      .map((item) => item.getAttribute('data-testid'));
    const pick = (id: string) => {
      press('products-collections');
      press(`products-collection-${id}`);
    };
    const search = (value: string) => fireEvent.change(screen.getByTestId('products-search'), { target: { value } });

    it("reads the catalogue's collection titles with the cached key, lists the titled ones, and a pick narrows the rows", async () => {
      const fetchMock = stub();
      sessionState.session = session;
      publishCatalogue(sale({ products: collected }));
      await mountCollections();
      expect((await screen.findByTestId('products-collections')).textContent).toBe('Collections');
      expect(chip().getAttribute('aria-label')).toBe('Collections');
      const reads = collectionReads(fetchMock);
      expect(reads).toHaveLength(1);
      const [input, init] = reads[0];
      expect(String(input).startsWith('https://store.test/store/collections?')).toBe(true);
      expect(new URL(String(input)).searchParams.getAll('id[]')).toEqual(['pcol_featured', 'pcol_summer', 'pcol_untitled']);
      expect(new Headers(init?.headers).get('x-publishable-api-key')).toBe('pk_1');
      press('products-collections');
      expect(menuIds()).toEqual(['products-collection-pcol_featured', 'products-collection-pcol_summer']);
      press('products-collection-pcol_featured');
      expect(screen.queryByTestId('products-collections-menu')).toBeNull();
      expect(rowIds()).toEqual(['v1', 'v5']);
      expect(chip().textContent).toBe('Featured');
      expect(chip().getAttribute('aria-label')).toBe('Collection: Featured');
      expect(footer()).toBe('Showing 2 of 6');
    });

    it('narrows together with In stock and the search, and the Tags chip still narrows alone', async () => {
      stub();
      sessionState.session = session;
      publishCatalogue(sale({ products: collected }));
      await mountCollections();
      await screen.findByTestId('products-collections');
      pick('pcol_featured');
      expect(rowIds()).toEqual(['v1', 'v5']);
      expect(footer()).toBe('Showing 2 of 6');
      search('E2E-5');
      expect(rowIds()).toEqual(['v5']);
      expect(footer()).toBe('Showing 1 of 6');
      search('');
      press('products-in-stock');
      expect(rowIds()).toEqual(['v1']);
      expect(footer()).toBe('Showing 1 of 6');
      press('products-in-stock');
      press('products-collections-remove');
      press('products-tags');
      press('products-tag-tag_seasonal');
      expect(rowIds()).toEqual(['p4', 'v5']);
      expect(screen.getByTestId('products-tags').getAttribute('aria-label')).toBe('Tag: Seasonal');
      expect(chip().textContent).toBe('Collections');
      expect(footer()).toBe('Showing 3 of 6');
    });

    it('says no product matches the search, else none in the collection when In stock empties it', async () => {
      stub();
      sessionState.session = session;
      publishCatalogue(sale({ products: collected }));
      await mountCollections();
      await screen.findByTestId('products-collections');
      pick('pcol_featured');
      search('E2E-4');
      expect(rowIds()).toEqual([]);
      expect(screen.getByText(PRODUCTS_NO_MATCH('E2E-4'))).toBeTruthy();
      expect(screen.queryByText(PRODUCTS_NONE_IN_COLLECTION('Featured'))).toBeNull();
      search('');
      press('category-nav-cat_food');
      expect(rowIds()).toEqual(['v5']);
      press('products-in-stock');
      expect(rowIds()).toEqual([]);
      expect(screen.getByText(PRODUCTS_NONE_IN_COLLECTION('Featured'))).toBeTruthy();
    });

    it('the cross takes the collection off, and a new mount starts with none', async () => {
      stub();
      sessionState.session = session;
      publishCatalogue(sale({ products: collected }));
      await mountCollections();
      await screen.findByTestId('products-collections');
      expect(screen.queryByTestId('products-collections-remove')).toBeNull();
      pick('pcol_featured');
      expect(rowIds()).toEqual(['v1', 'v5']);
      expect(screen.getByTestId('products-collections-remove').getAttribute('aria-label')).toBe('Remove collection');
      press('products-collections-remove');
      expect(rowIds()).toEqual(['p4', 'v1', 'v5', 'v6', 'v7']);
      expect(chip().textContent).toBe('Collections');
      expect(screen.queryByTestId('products-collections-remove')).toBeNull();
      expect(screen.queryByTestId('products-collections-menu')).toBeNull();
      pick('pcol_featured');
      cleanup();
      await mountCollections();
      expect((await screen.findByTestId('products-collections')).textContent).toBe('Collections');
      expect(rowIds()).toEqual(['p4', 'v1', 'v5', 'v6', 'v7']);
      expect(footer()).toBe('Showing 6 of 6');
    });

    it('no chip and no read when no product has a collection or no key is cached, and no chip when the read is refused', async () => {
      let fetchMock = stub();
      sessionState.session = session;
      publishCatalogue(sale({ products: collected.map((doc) => ({ ...doc, collection_id: undefined })) }));
      await mountCollections();
      expect(screen.getByTestId('products-tags')).toBeTruthy();
      expect(screen.queryByTestId('products-collections')).toBeNull();
      expect(collectionReads(fetchMock)).toEqual([]);
      cleanup();
      fetchMock = stub({ cached: false });
      publishCatalogue(sale({ products: collected }));
      await mountCollections();
      expect(screen.getByTestId('products-tags')).toBeTruthy();
      expect(screen.queryByTestId('products-collections')).toBeNull();
      expect(collectionReads(fetchMock)).toEqual([]);
      cleanup();
      fetchMock = stub({ status: 403 });
      await mountCollections();
      await vi.waitFor(() => expect(collectionReads(fetchMock)).toHaveLength(1));
      await act(async () => {});
      expect(screen.getByTestId('products-tags')).toBeTruthy();
      expect(screen.queryByTestId('products-collections')).toBeNull();
    });
  });

  // v2's On Sale chip, right after In stock: rows whose till price comes from a Medusa sale price list; not kept.
  describe('the On sale chip', () => {
    const organic = { id: 'tag_organic', value: 'Organic' };
    const seasonal = { id: 'tag_seasonal', value: 'Seasonal' };
    const onSale = (base: number, sale: number) => [...eur(base), { amount: sale, currency: 'EUR', kind: 'sale' as const }];
    // On sale: v1 (in stock), v4b (backorder) and v5 (out of stock); v4a is base-only.
    const saleDocs: Doc[] = [
      { ...categorized[0], tags: [organic], variants: [{ ...products[0].variants[0], prices: onSale(1000, 800) }] },
      { ...categorized[1], tags: [seasonal], variants: [products[1].variants[0], { ...products[1].variants[1], prices: onSale(2500, 2000) }] },
      { id: 'p5', title: 'E2E product 5', categories: [{ id: 'cat_food', name: 'Food' }], tags: [organic], variants: [
        { id: 'v5', title: 'Default', sku: 'E2E-5', prices: onSale(500, 400), stock: { status: 'out_of_stock', quantity: 0 } }] },
    ];
    // The tag list renders in a portal.
    const mountSale = () => render(<><ProductsAreaScreen /><PortalHost /></>);
    const chip = () => screen.getByTestId('products-on-sale');
    const footer = () => screen.getByTestId('products-footer').textContent;

    it('sits right after In stock, before the category chips, and a press narrows the table to the sale rows and back', () => {
      stubStorage();
      sessionState.session = session;
      publishCatalogue(sale({ products: saleDocs }));
      mountSale();
      expect(chip().getAttribute('aria-label')).toBe(PRODUCTS_ON_SALE_LABEL);
      expect(chip().textContent).toBe('On sale');
      expect(inStock().compareDocumentPosition(chip()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(chip().compareDocumentPosition(screen.getByTestId('category-nav-')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(chip().getAttribute('aria-pressed')).toBe('false');
      press('product-variations-p4');
      expect(rowIds()).toEqual(['p4', 'v1', 'v4a', 'v4b', 'v5']);
      press('products-on-sale');
      expect(chip().getAttribute('aria-pressed')).toBe('true');
      expect(rowIds()).toEqual(['p4', 'v1', 'v4b', 'v5']);
      press('products-on-sale');
      expect(chip().getAttribute('aria-pressed')).toBe('false');
      expect(rowIds()).toEqual(['p4', 'v1', 'v4a', 'v4b', 'v5']);
    });

    it('narrows together with In stock, the category, the tag and the search; the footer counts n of the catalogue', () => {
      stubStorage();
      sessionState.session = session;
      publishCatalogue(sale({ products: saleDocs }));
      mountSale();
      press('products-on-sale');
      expect(footer()).toBe('Showing 3 of 4');
      press('products-in-stock');
      expect(rowIds()).toEqual(['v1']);
      expect(footer()).toBe('Showing 1 of 4');
      press('products-in-stock');
      press('category-nav-cat_food');
      press('product-variations-p4');
      expect(rowIds()).toEqual(['p4', 'v4b', 'v5']);
      expect(footer()).toBe('Showing 2 of 4');
      press('products-tags');
      press(`products-tag-${seasonal.id}`);
      expect(rowIds()).toEqual(['p4', 'v4b']);
      expect(footer()).toBe('Showing 1 of 4');
      fireEvent.change(screen.getByTestId('products-search'), { target: { value: 'E2E-5' } });
      expect(rowIds()).toEqual([]);
      expect(footer()).toBe('Showing 0 of 4');
    });

    it('is not kept: a new mount starts with it off and every row shown', () => {
      stubStorage();
      sessionState.session = session;
      publishCatalogue(sale({ products: saleDocs }));
      mountSale();
      press('products-on-sale');
      press('product-variations-p4');
      expect(rowIds()).toEqual(['p4', 'v1', 'v4b', 'v5']);
      cleanup();
      mountSale();
      expect(chip().getAttribute('aria-pressed')).toBe('false');
      press('product-variations-p4');
      expect(rowIds()).toEqual(['p4', 'v1', 'v4a', 'v4b', 'v5']);
    });

    it('says nothing is on sale, or nothing on sale is in stock, and a search with no match still says so', () => {
      sessionState.session = session;
      publishCatalogue(sale());
      mount();
      expect(chip()).toBeTruthy();
      press('products-on-sale');
      expect(rowIds()).toEqual([]);
      expect(screen.getByText(PRODUCTS_NONE_ON_SALE)).toBeTruthy();
      cleanup();
      act(() => withdrawCatalogue('sale'));
      publishCatalogue(sale({ products: [{ ...products[1], variants: [products[1].variants[0],
        { ...products[1].variants[1], prices: onSale(2500, 2000) }] }] }));
      mount();
      press('products-on-sale');
      press('product-variations-p4');
      expect(rowIds()).toEqual(['p4', 'v4b']);
      press('products-in-stock');
      expect(rowIds()).toEqual([]);
      expect(screen.getByText(PRODUCTS_NONE_ON_SALE_IN_STOCK)).toBeTruthy();
      fireEvent.change(screen.getByTestId('products-search'), { target: { value: 'hat' } });
      expect(screen.getByText(PRODUCTS_NO_MATCH('hat'))).toBeTruthy();
    });

    it('on a phone the chip narrows the two-line list', () => {
      setWindowWidth(390, 844);
      stubStorage();
      sessionState.session = session;
      publishCatalogue(sale({ products: saleDocs }));
      mountSale();
      press('products-on-sale');
      press('product-variations-p4');
      expect(Array.from(document.querySelectorAll('[data-testid^="product-list-row-"]')).map((row) => row.getAttribute('data-testid')))
        .toEqual(['product-list-row-v1', 'product-list-row-p4', 'product-list-row-v4b', 'product-list-row-v5']);
    });

    it('Clear and Refresh on the screen\'s own read turns On sale off', async () => {
      const clearAndRefresh = vi.fn();
      vi.mocked(useReplicatedProducts).mockReturnValue(replicated({ products: medusaProducts, state: 'synced', syncNow: vi.fn(),
        clearAndRefresh }));
      sessionState.session = session;
      // The menu renders in a portal.
      await act(async () => { render(<><ProductsAreaScreen /><PortalHost /></>); });
      press('products-on-sale');
      expect(chip().getAttribute('aria-pressed')).toBe('true');
      fireEvent.contextMenu(screen.getByTestId('catalogue-sync'));
      fireEvent.click(screen.getByTestId('catalogue-clear-refresh'));
      expect(clearAndRefresh).toHaveBeenCalledTimes(1);
      expect(chip().getAttribute('aria-pressed')).toBe('false');
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
  it('the account avatar ends the search row on a wide window and is the header\'s right button on a phone (row 14a)', () => {
    const open = vi.fn();
    const mountFramed = () => render(<AppFrame signedIn><AccountPublisher open={open} /><ProductsAreaScreen /></AppFrame>);
    sessionState.session = session;
    publishCatalogue(sale());
    setWindowWidth(1024, 768);
    const { unmount } = mountFramed();
    const avatar = screen.getByTestId('area-user-menu');
    expect(screen.getByRole('main', { name: 'Products' }).contains(avatar)).toBe(true);
    expect(avatar.parentElement!.contains(screen.getByTestId('products-search'))).toBe(true);
    expect(avatar.parentElement!.lastElementChild).toBe(avatar);
    fireEvent.click(avatar);
    expect(open).toHaveBeenCalledOnce();
    unmount();
    setWindowWidth(390, 844);
    mountFramed();
    const phoneAvatar = screen.getByTestId('area-user-menu');
    expect(screen.getByRole('main', { name: 'Products' }).contains(phoneAvatar)).toBe(false);
    expect(screen.getByTestId('header-right').contains(phoneAvatar)).toBe(true);
  });

});

describe('on a phone', () => {
  beforeEach(() => setWindowWidth(390, 844));
  const listRows = () => Array.from(document.querySelectorAll('[data-testid^="product-list-row-"]'));
  const listRowIds = () => listRows().map((row) => row.getAttribute('data-testid')!.replace('product-list-row-', ''));
  const texts = (id: string) => within(screen.getByTestId(`product-list-row-${id}`)).getAllByText(/./).map((node) => node.textContent);
  const openP4 = () => fireEvent.click(screen.getByTestId('product-variations-p4'));

  it('lists two-line rows instead of the table, by name ascending', () => {
    sessionState.session = session;
    const reversed = [{ ...products[1], variants: [...products[1].variants].reverse() }, products[0]];
    publishCatalogue(sale({ products: reversed }));
    mount();
    expect(screen.getByTestId('products-list')).toBeTruthy();
    expect(screen.queryByTestId('products-table')).toBeNull();
    openP4();
    expect(listRowIds()).toEqual(['v1', 'p4', 'v4a', 'v4b']);
    expect(texts('v1')).toEqual(['E2E product 1', 'E2E-1', '€10.00', '5 · In stock']);
    expect(texts('v4b')).toEqual(['B', 'E2E-4B', '€25.00', 'On backorder']);
  });

  // v2's phone row starts with the product's image tile while the Image column is on (its default).
  it('starts each row with the image tile, a plain one for a product with no image', () => {
    sessionState.session = session;
    publishCatalogue(sale());
    mount();
    openP4();
    expect(listRowIds()).toEqual(['v1', 'p4', 'v4a', 'v4b']);
    for (const id of listRowIds()) {
      expect(within(screen.getByTestId(`product-list-row-${id}`)).getByTestId(`product-image-placeholder-${id}`)).toBeTruthy();
    }
  });

  // v2's column settings belong to the tablet table; a phone's two-line rows have no columns to choose.
  it('has no column settings button', () => {
    sessionState.session = session;
    publishCatalogue(sale());
    mount();
    expect(screen.getByTestId('products-list')).toBeTruthy();
    expect(screen.queryByTestId('products-settings-button')).toBeNull();
  });

  it('rows open nothing', () => {
    sessionState.session = session;
    publishCatalogue(sale());
    mount();
    openP4();
    expect(listRows()).toHaveLength(4);
    for (const row of listRows()) {
      expect(within(row as HTMLElement).queryAllByRole('button')).toEqual(row.getAttribute('data-testid') === 'product-list-row-p4'
        ? [screen.getByTestId('product-variations-p4')] : []);
    }
  });

  it('narrows with the search and the In stock chip, and says when nothing matches', () => {
    sessionState.session = session;
    publishCatalogue(sale());
    mount();
    fireEvent.change(screen.getByTestId('products-search'), { target: { value: 'E2E-4B' } });
    expect(listRowIds()).toEqual(['p4', 'v4b']);
    fireEvent.change(screen.getByTestId('products-search'), { target: { value: 'hat' } });
    expect(listRowIds()).toEqual([]);
    expect(screen.getByText(PRODUCTS_NO_MATCH('hat'))).toBeTruthy();
    fireEvent.change(screen.getByTestId('products-search'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('products-in-stock'));
    openP4();
    expect(listRowIds()).toEqual(['v1', 'p4', 'v4a']);
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

// v2: "On the Products and Orders screens, a scan goes into that screen's search box instead".
describe('a barcode scan', () => {
  const scanner = { ...DEFAULT_SCANNER_SETTINGS, prefix: '#', suffix: '!', playSound: true };
  const rowIds = () => Array.from(document.querySelectorAll('[data-testid^="product-row-"]'))
    .map((row) => row.getAttribute('data-testid')!.replace('product-row-', ''));
  const box = () => screen.getByTestId('products-search') as HTMLInputElement;
  const mountWith = (settings: typeof scanner, renderScreen = mount) => {
    const data = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } });
    saveScannerSettings(localStorage, session.baseUrl, settings);
    sessionState.session = session;
    publishCatalogue(sale());
    renderScreen();
  };
  // Types `raw` into the focused box `gapMs` apart, the field's value following each key as a real one does, then Enter.
  const typeInBox = (raw: string, gapMs: number) => {
    let t = 1_000;
    for (const key of Array.from(raw)) {
      vi.setSystemTime(t); t += gapMs;
      fireEvent.keyDown(box(), { key });
      fireEvent.change(box(), { target: { value: box().value + key } });
    }
    vi.setSystemTime(t);
    fireEvent.keyDown(box(), { key: 'Enter' });
  };
  // A wedge scan with nothing editable focused: keys land on the body.
  const scanOnBody = (raw: string) => {
    let t = 1_000;
    for (const key of [...Array.from(raw), 'Enter']) { vi.setSystemTime(t); t += 10; fireEvent.keyDown(document.body, { key }); }
  };

  beforeEach(() => { vi.useFakeTimers(); vi.mocked(playScanBeep).mockClear(); });
  afterEach(() => vi.useRealTimers());

  it('typed into the search box puts the bare code in the box, filters the table and beeps', () => {
    mountWith(scanner);
    typeInBox('#E2E-4B!', 10);
    expect(box().value).toBe('E2E-4B');
    expect(rowIds()).toEqual(['p4', 'v4b']);
    expect(playScanBeep).toHaveBeenCalledOnce();
    const toast = within(screen.getByTestId('scan-toast'));
    expect(toast.getByText('Barcode scanned: E2E-4B')).toBeTruthy();
    expect(toast.getByText('1 product matches')).toBeTruthy();
    expect(screen.getByTestId('products-footer').textContent).toBe('Showing 1 of 3');
  });

  it('with nothing focused fills the box the same way', () => {
    mountWith(scanner);
    scanOnBody('#E2E-4B!');
    expect(box().value).toBe('E2E-4B');
    expect(rowIds()).toEqual(['p4', 'v4b']);
    expect(playScanBeep).toHaveBeenCalledOnce();
    const toast = within(screen.getByTestId('scan-toast'));
    expect(toast.getByText('Barcode scanned: E2E-4B')).toBeTruthy();
    expect(toast.getByText('1 product matches')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(SCAN_TOAST_MS); });
    expect(screen.queryByTestId('scan-toast')).toBeNull();
  });

  it('puts a device scan into the box, filters the rows and shows the match count', () => {
    const hub: { current?: ReturnType<typeof useScanHub> } = {};
    function HubProbe() { hub.current = useScanHub(); return null; }
    mountWith(scanner, () => render(<ScanHubProvider profiles={{ read: async () => [], save: async () => {} }}
      settings={{ prefix: '', suffix: '', minChars: 3 }}><HubProbe /><ProductsAreaScreen /></ScanHubProvider>));
    act(() => { hub.current!.emit({ code: 'E2E-4B', source: { kind: 'hid-pos' }, timestamp: Date.now() }); });
    expect(box().value).toBe('E2E-4B');
    expect(rowIds()).toEqual(['p4', 'v4b']);
    const toast = within(screen.getByTestId('scan-toast'));
    expect(toast.getByText('Barcode scanned: E2E-4B')).toBeTruthy();
    expect(toast.getByText('1 product matches')).toBeTruthy();
  });

  it('announces a scan with no matching products as an alert', () => {
    mountWith(scanner);
    scanOnBody('#NOPE1!');
    const alert = within(screen.getByRole('alert'));
    expect(alert.getByText('Barcode scanned: NOPE1')).toBeTruthy();
    expect(alert.getByText('No products match')).toBeTruthy();
  });

  it('filters without a beep while Play a sound on scan is off', () => {
    mountWith({ ...scanner, playSound: false });
    typeInBox('#E2E-4B!', 10);
    expect(box().value).toBe('E2E-4B');
    expect(rowIds()).toEqual(['p4', 'v4b']);
    expect(playScanBeep).not.toHaveBeenCalled();
  });

  it('leaves slow typing as typed, with no beep', () => {
    mountWith(scanner);
    typeInBox('E2E-4B', 200);
    expect(box().value).toBe('E2E-4B');
    expect(rowIds()).toEqual(['p4', 'v4b']);
    expect(playScanBeep).not.toHaveBeenCalled();
    expect(screen.queryByTestId('scan-toast')).toBeNull();
  });
});

// v2's Expanded rows: a product with several variants is one row; "2 variations ›" opens its variants as rows under it.
describe('variation sub-rows', () => {
  const rowIds = () => Array.from(document.querySelectorAll('[data-testid^="product-row-"]'))
    .map((row) => row.getAttribute('data-testid')!.replace('product-row-', ''));
  const cells = (id: string) => within(screen.getByTestId(`product-row-${id}`)).getAllByText(/./).map((node) => node.textContent);
  const toggle = () => screen.getByTestId('product-variations-p4');
  const show = () => {
    sessionState.session = session;
    publishCatalogue(sale());
    mount();
  };

  it('on a tablet p4 is one closed row; its toggle shows the sub-rows A and B right after it, and hides them again', () => {
    show();
    expect(rowIds()).toEqual(['v1', 'p4']);
    expect(toggle().textContent).toBe('2 variations');
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(toggle().getAttribute('aria-label')).toBe('2 variations, E2E product 4');
    expect(within(screen.getByTestId('product-row-p4')).getByTestId('product-variations-p4')).toBeTruthy();
    fireEvent.click(toggle());
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(rowIds()).toEqual(['v1', 'p4', 'v4a', 'v4b']);
    expect(cells('v4a')).toEqual(['A', 'E2E-4', '2', 'In stock', '€20.00']);
    expect(cells('v4b')).toEqual(['B', 'E2E-4B', 'On backorder', 'On backorder', '€25.00']);
    fireEvent.click(toggle());
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(rowIds()).toEqual(['v1', 'p4']);
  });

  it("p4's row shows its price range and stock status, with no SKU", () => {
    show();
    expect(cells('p4')).toEqual(['E2E product 4', '2 variations', 'In stock', 'In stock', '€20.00 – €25.00']);
    expect(screen.getByTestId('product-stock-status-p4').textContent).toBe('In stock');
  });

  it('a search for a SKU opens p4 with only that variant under it', () => {
    show();
    fireEvent.change(screen.getByTestId('products-search'), { target: { value: 'E2E-4B' } });
    expect(rowIds()).toEqual(['p4', 'v4b']);
    expect(toggle().textContent).toBe('1 of 2 variations');
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('products-footer').textContent).toBe('Showing 1 of 3');
  });

  it('the In stock chip narrows p4 to v4a', () => {
    show();
    fireEvent.click(screen.getByTestId('products-in-stock'));
    expect(rowIds()).toEqual(['v1', 'p4']);
    expect(toggle().textContent).toBe('1 of 2 variations');
    fireEvent.click(toggle());
    expect(rowIds()).toEqual(['v1', 'p4', 'v4a']);
  });

  // The header cycles asc, desc, none; the table starts ascending, so one press sorts descending.
  it('sorting the Product column descending puts p4 first, its sub-rows B then A right under it', () => {
    show();
    fireEvent.click(toggle());
    fireEvent.click(screen.getByTestId('product-table-sort-name'));
    expect(rowIds()).toEqual(['p4', 'v4b', 'v4a', 'v1']);
  });

  it('on a phone p4 is one list row with the toggle, which shows its sub-rows after it', () => {
    setWindowWidth(390, 844);
    show();
    const listRowIds = () => Array.from(document.querySelectorAll('[data-testid^="product-list-row-"]'))
      .map((row) => row.getAttribute('data-testid')!.replace('product-list-row-', ''));
    expect(listRowIds()).toEqual(['v1', 'p4']);
    expect(within(screen.getByTestId('product-list-row-p4')).getByTestId('product-variations-p4').textContent).toBe('2 variations');
    fireEvent.click(toggle());
    expect(listRowIds()).toEqual(['v1', 'p4', 'v4a', 'v4b']);
  });
});

// v2's Product Settings › Variations, shared with the Sale's product panel: Open in place (a new device) fills the list with
// the product's variants under a Products back link; Expanded rows is the sub-rows above.
describe('the Variations choice', () => {
  const rowIds = () => Array.from(document.querySelectorAll('[data-testid^="product-row-"]'))
    .map((row) => row.getAttribute('data-testid')!.replace('product-row-', ''));
  const cells = (id: string) => within(screen.getByTestId(`product-row-${id}`)).getAllByText(/./).map((node) => node.textContent);
  const toggle = () => screen.getByTestId('product-variations-p4');
  const press = (testID: string) => fireEvent.click(screen.getByTestId(testID));
  const footer = () => screen.getByTestId('products-footer').textContent;
  // A new device: storage with nothing in it, or `entries` only.
  const storage = (...entries: [string, string][]) => {
    const data = new Map<string, string>(entries);
    vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } });
    return data;
  };
  // The sheet renders in a portal.
  const show = (catalogue: CatalogueSnapshot['products'] = products) => {
    sessionState.session = session;
    publishCatalogue(sale({ products: catalogue }));
    render(<><ProductsAreaScreen /><PortalHost /></>);
  };

  describe("v2's option filters in place", () => {
    const hoodie = { id: 'p6', title: 'Hoodie', options: [
      { id: 'size', title: 'Size', values: [{ value: 'S' }, { value: 'M' }] },
      { id: 'color', title: 'Color', values: [{ value: 'Blue' }, { value: 'Red' }] },
    ], variants: ['S', 'M'].flatMap((size) => ['Blue', 'Red'].map((color) => ({
      id: `${size}-${color}`, title: `${size} ${color}`, prices: eur(1000),
      stock: { status: size === 'S' && color === 'Red' ? 'out_of_stock' as const : 'in_stock' as const },
      options: [{ option_id: 'size', value: size }, { option_id: 'color', value: color }],
    }))) };
    const openHoodie = () => { storage(); show([...products, hoodie]); press('product-variations-p6'); };
    const pick = (id: string, value: string) => { press(`products-option-${id}`); press(`products-option-${id}-value-${value}`); };

    it('a product in place shows a chip per option; a picked value narrows the variants and reads "Size: M", and its cross takes it off', () => {
      openHoodie();
      const slot = within(screen.getByTestId('products-place-options'));
      const size = slot.getByTestId('products-option-size');
      expect(size.textContent).toBe('Size');
      expect(slot.getByTestId('products-option-color').textContent).toBe('Color');
      press('products-option-size');
      expect(screen.getByTestId('products-option-size-search').getAttribute('placeholder')).toBe('Search Size');
      press('products-option-size-value-M');
      expect(rowIds()).toEqual(['M-Blue', 'M-Red']);
      expect(footer()).toBe('Showing 2 of 4');
      expect(size.textContent).toBe('Size: M');
      expect(size.getAttribute('aria-label')).toBe('Size: M');
      press('products-option-size-remove');
      expect(size.textContent).toBe('Size');
      expect(rowIds()).toHaveLength(4);
      expect(footer()).toBe('Showing 4 of 4');
    });

    it('two chips narrow together and with In stock; a combination with no variant says so and keeps the chips', () => {
      openHoodie();
      pick('color', 'Red');
      expect(footer()).toBe('Showing 2 of 4');
      press('products-in-stock');
      expect(rowIds()).toEqual(['M-Red']);
      expect(footer()).toBe('Showing 1 of 4');
      pick('size', 'S');
      expect(rowIds()).toEqual([]);
      expect(screen.getByText(PRODUCTS_NONE_WITH_OPTIONS)).toBeTruthy();
      expect(screen.getByTestId('products-place-options')).toBeTruthy();
    });

    it('with an option chosen, On sale that leaves the product nothing names On sale, not the options', () => {
      openHoodie();
      pick('size', 'M');
      expect(rowIds()).toEqual(['M-Blue', 'M-Red']);
      press('products-on-sale');
      expect(rowIds()).toEqual([]);
      expect(screen.getByText(PRODUCTS_NONE_ON_SALE)).toBeTruthy();
      expect(screen.queryByText(PRODUCTS_NONE_WITH_OPTIONS)).toBeNull();
      expect(screen.getByTestId('products-place-options')).toBeTruthy();
      press('products-on-sale');
      expect(rowIds()).toEqual(['M-Blue', 'M-Red']);
    });

    it('going back or opening the product again starts with no choice; the list, Expanded rows and p4 show no option chips', () => {
      openHoodie();
      pick('size', 'M');
      press('products-place-back');
      expect(screen.queryByTestId('products-place-options')).toBeNull();
      press('product-variations-p6');
      expect(screen.getByTestId('products-option-size').textContent).toBe('Size');
      expect(footer()).toBe('Showing 4 of 4');
      press('products-place-back');
      press('product-variations-p4');
      expect(screen.queryByTestId('products-place-options')).toBeNull();
      press('products-settings-button');
      press('products-settings-variations-popover');
      press('products-settings-close');
      press('product-variations-p6');
      expect(rowIds()).toContain('M-Red');
      expect(screen.queryByTestId('products-place-options')).toBeNull();
    });

    it('on a phone the chips sit above the in-place list and narrow it', () => {
      setWindowWidth(390, 844);
      openHoodie();
      pick('color', 'Blue');
      const list = screen.getByTestId('products-list');
      const slot = within(list).getByTestId('products-place-options');
      const rows = list.querySelectorAll('[data-testid^="product-list-row-"]');
      expect(Array.from(rows, (row) => row.getAttribute('data-testid'))).toEqual(['product-list-row-M-Blue', 'product-list-row-S-Blue']);
      expect(slot.compareDocumentPosition(rows[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
  });

  it('a new device opens p4 in place: its variants A and B under a Products back link, which returns to the list', () => {
    storage();
    show();
    expect(rowIds()).toEqual(['v1', 'p4']);
    expect(toggle().hasAttribute('aria-expanded')).toBe(false);
    expect(toggle().textContent).toBe('2 variations');
    expect(toggle().getAttribute('aria-label')).toBe('2 variations, E2E product 4');
    expect(screen.queryByTestId('products-place')).toBeNull();
    fireEvent.click(toggle());
    expect(screen.getByTestId('products-place-name').textContent).toBe('E2E product 4');
    expect(screen.getByTestId('products-place').contains(screen.getByTestId('products-place-back'))).toBe(true);
    expect(screen.getByTestId('products-place-back').textContent).toBe('Products');
    expect(rowIds()).toEqual(['v4a', 'v4b']);
    expect(cells('v4a')[0]).toBe('A');
    expect(cells('v4b')[0]).toBe('B');
    expect(footer()).toBe('Showing 2 of 2');
    press('products-place-back');
    expect(screen.queryByTestId('products-place')).toBeNull();
    expect(rowIds()).toEqual(['v1', 'p4']);
    expect(toggle().hasAttribute('aria-expanded')).toBe(false);
    expect(footer()).toBe('Showing 3 of 3');
  });

  it('in place the In stock chip narrows the variants, and n counts them of the product', () => {
    storage();
    show();
    press('products-in-stock');
    fireEvent.click(toggle());
    expect(rowIds()).toEqual(['v4a']);
    expect(footer()).toBe('Showing 1 of 2');
  });

  it('a search shows the matching variant under p4 in the list and in place; back keeps the search and the chips', () => {
    storage();
    show();
    fireEvent.change(screen.getByTestId('products-search'), { target: { value: 'E2E-4B' } });
    expect(rowIds()).toEqual(['p4', 'v4b']);
    expect(toggle().hasAttribute('aria-expanded')).toBe(false);
    fireEvent.click(toggle());
    expect(rowIds()).toEqual(['v4b']);
    expect(footer()).toBe('Showing 1 of 2');
    // No variant left: the empty-state text, with the back row still shown.
    press('products-in-stock');
    expect(rowIds()).toEqual([]);
    expect(screen.getByText(PRODUCTS_NO_MATCH('E2E-4B'))).toBeTruthy();
    expect(screen.getByTestId('products-place-back')).toBeTruthy();
    press('products-place-back');
    expect(screen.queryByTestId('products-place')).toBeNull();
    expect((screen.getByTestId('products-search') as HTMLInputElement).value).toBe('E2E-4B');
    expect(screen.getByTestId('products-in-stock').getAttribute('aria-pressed')).toBe('true');
  });

  it('on web Escape in place goes back to the list and keeps the search and the chips', () => {
    storage();
    show();
    fireEvent.change(screen.getByTestId('products-search'), { target: { value: 'E2E-4B' } });
    fireEvent.click(toggle());
    press('products-in-stock');
    expect(screen.getByTestId('products-place')).toBeTruthy();
    act(() => { fireEvent.keyDown(document.body, { key: 'Escape' }); });
    expect(screen.queryByTestId('products-place')).toBeNull();
    expect((screen.getByTestId('products-search') as HTMLInputElement).value).toBe('E2E-4B');
    expect(screen.getByTestId('products-in-stock').getAttribute('aria-pressed')).toBe('true');
    expect(rowIds()).toEqual([]);
  });

  it('on web Escape typed in the search box keeps the product open in place', () => {
    storage();
    show();
    fireEvent.click(toggle());
    const search = screen.getByTestId('products-search');
    act(() => { search.focus(); });
    act(() => { fireEvent.keyDown(search, { key: 'Escape' }); });
    expect(screen.getByTestId('products-place')).toBeTruthy();
  });

  it('on web Escape with the Product Settings sheet open does not go back', () => {
    storage();
    show();
    fireEvent.click(toggle());
    press('products-settings-button');
    act(() => { fireEvent.keyDown(document.body, { key: 'Escape' }); });
    expect(screen.getByTestId('products-place')).toBeTruthy();
    if (screen.queryByTestId('products-settings-close')) press('products-settings-close');
    act(() => { fireEvent.keyDown(document.body, { key: 'Escape' }); });
    expect(screen.queryByTestId('products-place')).toBeNull();
  });

  it('Escape on the list with nothing open in place changes nothing', () => {
    storage();
    show();
    expect(rowIds()).toEqual(['v1', 'p4']);
    expect(() => act(() => { fireEvent.keyDown(document.body, { key: 'Escape' }); })).not.toThrow();
    expect(rowIds()).toEqual(['v1', 'p4']);
  });

  it('sorting the Product column descending in place lists B then A', () => {
    storage();
    show();
    fireEvent.click(toggle());
    press('product-table-sort-name');
    expect(rowIds()).toEqual(['v4b', 'v4a']);
  });

  it('is kept per store: Expanded rows stored for this store gives sub-rows, stored for another store leaves Open in place', () => {
    storage(['medusapos.product-settings.https://store.test', JSON.stringify({ variations: 'popover' })]);
    show();
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle());
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(rowIds()).toEqual(['v1', 'p4', 'v4a', 'v4b']);
    expect(screen.queryByTestId('products-place')).toBeNull();
    cleanup();
    act(() => withdrawCatalogue('sale'));
    storage(['medusapos.product-settings.https://other.test', JSON.stringify({ variations: 'popover' })]);
    show();
    expect(toggle().hasAttribute('aria-expanded')).toBe(false);
    fireEvent.click(toggle());
    expect(screen.getByTestId('products-place-name').textContent).toBe('E2E product 4');
  });

  it('choosing Expanded rows in the sheet while p4 is open in place returns to the list with the sub-row toggle', () => {
    const data = storage();
    show();
    fireEvent.click(toggle());
    expect(rowIds()).toEqual(['v4a', 'v4b']);
    press('products-settings-button');
    expect(screen.getByTestId('products-settings-variations-list').getAttribute('aria-selected')).toBe('true');
    press('products-settings-variations-popover');
    expect(screen.getByTestId('products-settings-variations-popover').getAttribute('aria-selected')).toBe('true');
    expect(JSON.parse(data.get('medusapos.product-settings.https://store.test')!)).toEqual({ variations: 'popover', tileFields: DEFAULT_TILE_FIELDS, browse: 'chips' });
    press('products-settings-close');
    expect(screen.queryByTestId('products-place')).toBeNull();
    expect(rowIds()).toEqual(['v1', 'p4']);
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle());
    expect(rowIds()).toEqual(['v1', 'p4', 'v4a', 'v4b']);
  });

  it("is the Sale's own setting: a save through the Sale's hook is what the area shows, and the area's choice is what the Sale reads", () => {
    storage();
    show();
    const { result } = renderHook(() => useProductSettings(localStorage, session.baseUrl));
    expect(result.current.settings).toEqual({ variations: 'list', tileFields: DEFAULT_TILE_FIELDS, browse: 'chips' });
    act(() => result.current.save({ variations: 'popover', tileFields: DEFAULT_TILE_FIELDS, browse: 'chips' }));
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    press('products-settings-button');
    press('products-settings-variations-list');
    expect(result.current.settings).toEqual({ variations: 'list', tileFields: DEFAULT_TILE_FIELDS, browse: 'chips' });
    expect(toggle().hasAttribute('aria-expanded')).toBe(false);
  });

  it('on a phone opens p4 in place: its variant rows under the back row, and back returns to the list', () => {
    setWindowWidth(390, 844);
    storage();
    show();
    const listRowIds = () => Array.from(document.querySelectorAll('[data-testid^="product-list-row-"]'))
      .map((row) => row.getAttribute('data-testid')!.replace('product-list-row-', ''));
    expect(listRowIds()).toEqual(['v1', 'p4']);
    fireEvent.click(toggle());
    expect(listRowIds()).toEqual(['v4a', 'v4b']);
    expect(screen.getByTestId('products-place').compareDocumentPosition(screen.getByTestId('products-list'))
      & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(footer()).toBe('Showing 2 of 2');
    press('products-place-back');
    expect(listRowIds()).toEqual(['v1', 'p4']);
  });
});

// v2's Type column: the till reads the product types from Medusa only while the column shows.
describe('the Type column', () => {
  const typed = [products[0], { ...products[1], type_id: 'ptyp_apparel' }];
  const stub = () => {
    const data = new Map<string, string>([EXPANDED_ROWS]);
    vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } });
    const fetchMock = vi.fn(async (input: string | URL | Request) => String(input).includes('/admin/product-types')
      ? new Response(JSON.stringify({ product_types: [{ id: 'ptyp_apparel', value: 'Apparel' }] }), { status: 200 })
      : new Response('{}', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };
  const typeReads = (fetchMock: ReturnType<typeof stub>) =>
    fetchMock.mock.calls.map(([input]) => String(input)).filter((url) => url.includes('/admin/product-types'));

  it('reads no product types while Type is off', async () => {
    const fetchMock = stub();
    sessionState.session = session;
    publishCatalogue(sale({ products: typed }));
    await mountRead();
    expect(screen.queryByTestId('product-type-p4')).toBeNull();
    expect(typeReads(fetchMock)).toEqual([]);
  });

  it("with Type on reads the catalogue's type ids and shows the value on the product row and its sub-rows", async () => {
    const fetchMock = stub();
    localStorage.setItem('medusapos.products-area-columns.https://store.test', JSON.stringify({ type: true }));
    sessionState.session = session;
    publishCatalogue(sale({ products: typed }));
    await mountRead();
    expect(await screen.findByText('Apparel')).toBeTruthy();
    const reads = typeReads(fetchMock);
    expect(reads).toHaveLength(1);
    expect(new URL(reads[0]).searchParams.getAll('id[]')).toEqual(['ptyp_apparel']);
    expect(reads[0].startsWith('https://store.test/admin/product-types?')).toBe(true);
    expect(screen.getByTestId('product-type-p4').textContent).toBe('Apparel');
    expect(screen.getByTestId('product-type-v1').textContent).toBe('');
    fireEvent.click(screen.getByTestId('product-variations-p4'));
    expect(screen.getByTestId('product-type-v4a').textContent).toBe('Apparel');
    expect(screen.getByTestId('product-type-v4b').textContent).toBe('Apparel');
    expect(typeReads(fetchMock)).toHaveLength(1);
  });
});
