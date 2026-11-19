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
vi.mock('expo-router',() => ({ Redirect: () => null, usePathname: () => '/products', Stack: { Screen: () => null } }));
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
  categories: 'Drinks', categoryIds: ['c1'], tagIds: [], imageUrl: 'https://img.test/tea.png',
  regularPrice: '€3.00', salePrice: '', onSale: false, type: 'Hot drinks', attributes: 'Size: Large, Leaf: Green',
};
// A product with no image (the placeholder tile), on sale.
const coffee: ProductAreaRow = { ...tea, id: 'p2', name: 'Coffee', sku: 'COF-1', imageUrl: undefined,
  price: '€2.00', regularPrice: '€2.50', salePrice: '€2.00', onSale: true, type: '', attributes: '' };
vi.mock('../lib/products-area', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/products-area')>(),
  productAreaRows: () => [tea, coffee],
}));
vi.mock('@tallyui/pos', async (importOriginal) => ({
  ...await importOriginal<typeof import('@tallyui/pos')>(),
  listCategories: () => [],
}));

const KEY = 'medusapos.products-area-columns.https://store.test';
const IDS = ['image', 'id', 'type', 'sku', 'barcode', 'stock', 'stockStatus', 'category', 'price', 'regularPrice', 'salePrice'] as const;
const column = (id: string) => screen.getByTestId(`products-settings-column-${id}`);
const LINES = [['sku', 'SKU'], ['barcode', 'Barcode'], ['attributes', 'Attributes']] as const;
const subSwitch = (line: string) => screen.getByTestId(`products-settings-product-${line}`);
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

it('opens a Product Settings sheet with a switch for each optional column, Image first, ID, Type, Barcode, Regular price and Sale price off and the rest on', () => {
  openSheet();
  const sheet = screen.getByTestId('products-settings-sheet');
  expect(sheet.textContent).toContain('Product Settings');
  expect(sheet.querySelectorAll('[role="switch"]')).toHaveLength(14);
  const labels = IDS.map((id) => document.getElementById(`products-settings-column-${id}-label`)?.textContent);
  expect(labels).toEqual(['Image', 'ID', 'Type', 'SKU', 'Barcode', 'Stock', 'Stock status', 'Category', 'Price', 'Regular price', 'Sale price']);
  const off = ['id', 'type', 'barcode', 'regularPrice', 'salePrice'];
  for (const id of IDS) expect(column(id).getAttribute('aria-checked')).toBe(off.includes(id) ? 'false' : 'true');
  // v2's order: ID, then the Product label with its SKU, Barcode and Attributes sub-switches (all off), then Type.
  expect(screen.getByTestId('products-settings-product').textContent).toBe('Product');
  expect(screen.getByTestId('products-settings-product').querySelector('[role="switch"]')).toBeNull();
  for (const [line, label] of LINES) {
    expect(document.getElementById(`products-settings-product-${line}-label`)?.textContent).toBe(label);
    expect(subSwitch(line).getAttribute('aria-checked')).toBe('false');
  }
  const order = Array.from(sheet.querySelectorAll('[data-testid^="products-settings-column-"], [data-testid^="products-settings-product"]'))
    .map((node) => node.getAttribute('data-testid')!.replace('products-settings-', ''));
  expect(order.slice(0, 7)).toEqual(['column-image', 'column-id', 'product', 'product-sku', 'product-barcode', 'product-attributes', 'column-type']);
});

it("shows v2's Type column right after Product when its switch goes on, each row's type, and saves the choice", () => {
  openSheet();
  expect(heads()).not.toContain('Type');
  fireEvent.click(column('type'));
  expect(column('type').getAttribute('aria-checked')).toBe('true');
  expect(heads()).toEqual(['', 'Product', 'Type', 'SKU', 'Stock', 'Stock status', 'Category', 'Price']);
  expect(screen.getByTestId('product-type-p1').textContent).toBe('Hot drinks');
  expect(screen.getByTestId('product-type-p2').textContent).toBe('');
  expect(JSON.parse(localStorage.getItem(KEY) ?? 'null')).toMatchObject({ type: true });
});

it("adds each Product sub-switch's line under the variant row's name, apart from the SKU and Barcode columns", () => {
  openSheet();
  const values = { sku: 'TEA-1', barcode: '4006381333931', attributes: 'Size: Large, Leaf: Green' };
  for (const [line] of LINES) {
    expect(screen.queryByTestId(`product-line-${line}-p1`)).toBeNull();
    fireEvent.click(subSwitch(line));
    expect(subSwitch(line).getAttribute('aria-checked')).toBe('true');
    const shown = screen.getByTestId(`product-line-${line}-p1`);
    expect(shown.textContent).toBe(values[line]);
    expect(shown.parentElement?.firstChild?.textContent).toBe('Tea');
  }
  // Coffee has no attributes: no empty line.
  expect(screen.getByTestId('product-line-sku-p2').textContent).toBe('COF-1');
  expect(screen.queryByTestId('product-line-attributes-p2')).toBeNull();
  // The standalone columns stay as they were: SKU on, Barcode off.
  expect(heads()).toEqual(['', 'Product', 'SKU', 'Stock', 'Stock status', 'Category', 'Price']);
  expect(JSON.parse(localStorage.getItem(KEY) ?? 'null'))
    .toMatchObject({ productSku: true, productBarcode: true, productAttributes: true, sku: true, barcode: false });
  fireEvent.click(subSwitch('barcode'));
  expect(screen.queryByTestId('product-line-barcode-p1')).toBeNull();
  expect(screen.getByTestId('product-line-sku-p1')).toBeTruthy();
  fireEvent.click(screen.getByTestId('products-settings-restore'));
  for (const [line] of LINES) {
    expect(subSwitch(line).getAttribute('aria-checked')).toBe('false');
    expect(screen.queryByTestId(`product-line-${line}-p1`)).toBeNull();
  }
});

// jsdom's react-native-web drops className, so the greying is checked in the browser (e2e/products-area.spec.ts).
it("shows v2's Regular price and Sale price columns when their switches go on, and saves the choice", () => {
  openSheet();
  fireEvent.click(column('regularPrice'));
  fireEvent.click(column('salePrice'));
  expect(heads()).toEqual(['', 'Product', 'SKU', 'Stock', 'Stock status', 'Category', 'Price', 'Regular price', 'Sale price']);
  expect(screen.getByTestId('product-regular-price-p2').textContent).toBe('€2.50');
  expect(screen.getByTestId('product-sale-price-p2').textContent).toBe('€2.00');
  expect(screen.getByTestId('product-regular-price-p1').textContent).toBe('€3.00');
  expect(screen.getByTestId('product-sale-price-p1').textContent).toBe('');
  expect(JSON.parse(localStorage.getItem(KEY) ?? 'null')).toMatchObject({ regularPrice: true, salePrice: true });
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
