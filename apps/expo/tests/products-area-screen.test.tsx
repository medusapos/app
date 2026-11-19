// @vitest-environment jsdom
// @ts-expect-error no @types/react-dom in this Expo/React Native app
import { createPortal } from 'react-dom';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StoreSettingsError, type ProductTraits, type StoreSettings as PricingSettings, type VariantSummary } from '@tallyui/core';
import { useStoreSettings } from '@tallyui/pos';
import { PortalHost } from '@tallyui/primitives';
import type { Session } from '../lib/session';
import { publishCatalogue, withdrawCatalogue, type CatalogueSnapshot } from '../lib/catalogue-snapshot';
import {
  PRODUCTS_ADMIN_NOTE, PRODUCTS_EMPTY, PRODUCTS_LOADING, PRODUCTS_NO_MATCH, PRODUCTS_NONE_IN_STOCK, PRODUCTS_NONE_ON_SALE,
  PRODUCTS_NONE_ON_SALE_IN_STOCK, PRODUCTS_NONE_TAGGED, PRODUCTS_ON_SALE_LABEL, PRODUCTS_TAGS_NONE, PRODUCTS_TAGS_SEARCH, saveProductsAreaCategory, saveProductsAreaTag,
} from '../lib/products-area';
import { fetchStoreSettings, loadSettingsChoice, type StoreSettings } from '../lib/store-settings';
import { playScanBeep } from '../lib/scan-beep';
import { DEFAULT_SCANNER_SETTINGS, saveScannerSettings } from '../lib/scanner-settings';
import { useReplicatedProducts } from '../lib/use-replicated-products';
import { capabilities, storeSettings } from './pos-connector-mock';
import ProductsAreaScreen from '../app/products';
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
      expect(screen.getByTestId('products-settings-button')).toBeTruthy();
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
      expect(rowIds()).toEqual(['v4a', 'v4b', 'v5']);
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
      expect(rowIds()).toEqual(['v4a', 'v4b', 'v5']);
      press('products-in-stock');
      expect(rowIds()).toEqual(['v4a']);
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
      expect(rowIds()).toEqual(['v1', 'v4a', 'v4b', 'v5']);
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
      expect(rowIds()).toEqual(['v1', 'v4a', 'v4b', 'v5']);
      cleanup();
      saveProductsAreaTag(localStorage, session.baseUrl, 'tag_gone');
      mountTags();
      expect(chip().textContent).toBe('Tags');
      expect(rowIds()).toEqual(['v1', 'v4a', 'v4b', 'v5']);
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
      expect(rowIds()).toEqual(['v1', 'v4a', 'v4b', 'v5']);
      press('products-on-sale');
      expect(chip().getAttribute('aria-pressed')).toBe('true');
      expect(rowIds()).toEqual(['v1', 'v4b', 'v5']);
      press('products-on-sale');
      expect(chip().getAttribute('aria-pressed')).toBe('false');
      expect(rowIds()).toEqual(['v1', 'v4a', 'v4b', 'v5']);
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
      expect(rowIds()).toEqual(['v4b', 'v5']);
      expect(footer()).toBe('Showing 2 of 4');
      press('products-tags');
      press(`products-tag-${seasonal.id}`);
      expect(rowIds()).toEqual(['v4b']);
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
      expect(rowIds()).toEqual(['v1', 'v4b', 'v5']);
      cleanup();
      mountSale();
      expect(chip().getAttribute('aria-pressed')).toBe('false');
      expect(rowIds()).toEqual(['v1', 'v4a', 'v4b', 'v5']);
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
      expect(rowIds()).toEqual(['v4b']);
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
      expect(Array.from(document.querySelectorAll('[data-testid^="product-list-row-"]')).map((row) => row.getAttribute('data-testid')))
        .toEqual(['product-list-row-v1', 'product-list-row-v4b', 'product-list-row-v5']);
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

  // v2's phone row starts with the product's image tile while the Image column is on (its default).
  it('starts each row with the image tile, a plain one for a product with no image', () => {
    sessionState.session = session;
    publishCatalogue(sale());
    mount();
    expect(listRowIds()).toEqual(['v1', 'v4a', 'v4b']);
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

// v2: "On the Products and Orders screens, a scan goes into that screen's search box instead".
describe('a barcode scan', () => {
  const scanner = { ...DEFAULT_SCANNER_SETTINGS, prefix: '#', suffix: '!', playSound: true };
  const rowIds = () => Array.from(document.querySelectorAll('[data-testid^="product-row-"]'))
    .map((row) => row.getAttribute('data-testid')!.replace('product-row-', ''));
  const box = () => screen.getByTestId('products-search') as HTMLInputElement;
  const mountWith = (settings: typeof scanner) => {
    const data = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } });
    saveScannerSettings(localStorage, session.baseUrl, settings);
    sessionState.session = session;
    publishCatalogue(sale());
    mount();
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
    expect(rowIds()).toEqual(['v4b']);
    expect(playScanBeep).toHaveBeenCalledOnce();
  });

  it('with nothing focused fills the box the same way', () => {
    mountWith(scanner);
    scanOnBody('#E2E-4B!');
    expect(box().value).toBe('E2E-4B');
    expect(rowIds()).toEqual(['v4b']);
    expect(playScanBeep).toHaveBeenCalledOnce();
  });

  it('filters without a beep while Play a sound on scan is off', () => {
    mountWith({ ...scanner, playSound: false });
    typeInBox('#E2E-4B!', 10);
    expect(box().value).toBe('E2E-4B');
    expect(rowIds()).toEqual(['v4b']);
    expect(playScanBeep).not.toHaveBeenCalled();
  });

  it('leaves slow typing as typed, with no beep', () => {
    mountWith(scanner);
    typeInBox('E2E-4B', 200);
    expect(box().value).toBe('E2E-4B');
    expect(rowIds()).toEqual(['v4b']);
    expect(playScanBeep).not.toHaveBeenCalled();
  });
});
