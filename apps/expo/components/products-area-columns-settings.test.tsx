// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PortalHost } from '@tallyui/primitives';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ProductsAreaScreen from '../app/products';
import type { ProductAreaRow } from '../lib/products-area';
import { DEFAULT_PRODUCTS_AREA_COLUMNS } from '../lib/products-area-columns';

// jsdom gives react-native-web no window width; a tablet's, so the table (not the phone list) renders.
vi.mock('react-native', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-native')>(),
  useWindowDimensions: () => ({ width: 1024, height: 768, scale: 1, fontScale: 1 }),
}));
vi.mock('expo-router',() => ({ Redirect: () => null, Stack: { Screen: () => null } }));
vi.mock('./app-frame', () => ({ AreaAccountButton: () => null, FrameMenuButton: () => null, useFrameMenu: () => undefined }));
vi.mock('../lib/session-context', () => ({ useSession: () => ({
  session: { baseUrl: 'https://store.test', token: 't' },
  signOut: () => {}, reportUnauthorized: () => {}, reportNoPosAccess: () => {}, mergeCapabilities: () => {},
}) }));
// The Sale holds a ready catalogue for the store, so the area reads nothing itself.
vi.mock('../lib/catalogue-snapshot', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/catalogue-snapshot')>(),
  useCatalogueSnapshot: () => ({ owner: 'sale', baseUrl: 'https://store.test', status: 'ready', products: [], traits: {}, currency: 'EUR' }),
}));
const tea: ProductAreaRow = {
  id: 'p1', name: 'Tea', sku: 'TEA-1', barcode: '4006381333931', price: '€3.00', stock: '12', stockStatus: 'in_stock',
  categories: 'Drinks', categoryIds: ['c1'], imageUrl: 'https://img.test/tea.png',
};
// A product with no image: the placeholder tile.
const coffee: ProductAreaRow = { ...tea, id: 'p2', name: 'Coffee', sku: 'COF-1', imageUrl: undefined };
vi.mock('../lib/products-area', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/products-area')>(),
  productAreaRows: () => [tea, coffee],
}));
vi.mock('@tallyui/pos', async (importOriginal) => ({
  ...await importOriginal<typeof import('@tallyui/pos')>(),
  listCategories: () => [],
}));

const KEY = 'medusapos.products-area-columns.https://store.test';
const IDS = ['image', 'id', 'sku', 'barcode', 'stock', 'stockStatus', 'category', 'price'] as const;
const column = (id: string) => screen.getByTestId(`products-settings-column-${id}`);
// A head's text without the sort arrow the sorted column carries ("Product ▲").
const heads = () => screen.getAllByRole('columnheader').map((head) => head.textContent?.replace(/ [▲▼]$/, ''));

// A fresh store per test; jsdom here has no localStorage of its own.
beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function openSheet() {
  render(<><ProductsAreaScreen /><PortalHost /></>);
  expect(screen.getByTestId('product-row-p1')).toBeTruthy();
  fireEvent.click(screen.getByTestId('products-settings-button'));
}

it('opens a Product Settings sheet with a switch for each optional column, Image first, ID and Barcode off and the rest on', () => {
  openSheet();
  const sheet = screen.getByTestId('products-settings-sheet');
  expect(sheet.textContent).toContain('Product Settings');
  expect(sheet.querySelectorAll('[role="switch"]')).toHaveLength(8);
  const labels = IDS.map((id) => document.getElementById(`products-settings-column-${id}-label`)?.textContent);
  expect(labels).toEqual(['Image', 'ID', 'SKU', 'Barcode', 'Stock', 'Stock status', 'Category', 'Price']);
  for (const id of IDS) expect(column(id).getAttribute('aria-checked')).toBe(id === 'id' || id === 'barcode' ? 'false' : 'true');
});

it('shows the ID and Barcode columns, in v2\'s order, when their switches go on, and saves the choice', () => {
  openSheet();
  expect(heads()).not.toContain('ID');
  expect(heads()).not.toContain('Barcode');
  fireEvent.click(column('id'));
  fireEvent.click(column('barcode'));
  expect(heads()).toEqual(['', 'ID', 'Product', 'SKU', 'Barcode', 'Stock', 'Stock status', 'Category', 'Price']);
  const row = screen.getByTestId('product-row-p1');
  expect(row.textContent).toContain('p1');
  expect(row.textContent).toContain('4006381333931');
  expect(JSON.parse(localStorage.getItem(KEY) ?? 'null')).toMatchObject({ id: true, barcode: true });
});

it('hides the SKU column when its switch goes off, keeps Product, and saves the choice for the store', () => {
  openSheet();
  expect(heads()).toContain('SKU');
  fireEvent.click(column('sku'));
  expect(column('sku').getAttribute('aria-checked')).toBe('false');
  expect(heads()).not.toContain('SKU');
  expect(heads()).toContain('Product');
  expect(JSON.parse(localStorage.getItem(KEY) ?? 'null')).toMatchObject({ sku: false });
});

it('honours a stored choice on first render, and Restore Default Settings brings the defaults back', () => {
  localStorage.setItem(KEY, JSON.stringify({ price: false, category: false }));
  openSheet();
  expect(heads()).not.toContain('Price');
  expect(heads()).not.toContain('Category');
  fireEvent.click(screen.getByTestId('products-settings-restore'));
  expect(heads()).toEqual(['', 'Product', 'SKU', 'Stock', 'Stock status', 'Category', 'Price']);
  for (const id of IDS) expect(column(id).getAttribute('aria-checked')).toBe(String(DEFAULT_PRODUCTS_AREA_COLUMNS[id]));
});

it("shows v2's image column by default: each row's thumbnail, a plain tile without one, and a head with no label", () => {
  openSheet();
  const table = screen.getByTestId('products-table');
  expect(table.querySelector('[data-testid="product-image-p1"]')).not.toBeNull();
  const head = screen.getAllByRole('columnheader')[0];
  expect(head.textContent).toBe('');
  expect(head.getAttribute('aria-label')).toBe('Image');
  expect(table.querySelector('[data-testid="product-image-placeholder-p2"]')).not.toBeNull();
  expect(table.querySelector('[data-testid="product-image-p2"]')).toBeNull();
  expect(table.querySelector('[data-testid="product-image-placeholder-p1"]')).toBeNull();
});

it('hides the image column and its empty head when Image goes off, and saves the choice', () => {
  openSheet();
  expect(heads()[0]).toBe('');
  fireEvent.click(column('image'));
  expect(column('image').getAttribute('aria-checked')).toBe('false');
  expect(screen.getByTestId('products-table').querySelectorAll('[data-testid^="product-image-"]')).toHaveLength(0);
  expect(heads()).toEqual(['Product', 'SKU', 'Stock', 'Stock status', 'Category', 'Price']);
  expect(JSON.parse(localStorage.getItem(KEY) ?? 'null')).toMatchObject({ image: false });
});

it('closes the sheet on Close', () => {
  openSheet();
  expect(screen.getByTestId('products-settings-sheet')).toBeTruthy();
  fireEvent.click(screen.getByTestId('products-settings-close'));
  expect(screen.queryByTestId('products-settings-sheet')).toBeNull();
});
