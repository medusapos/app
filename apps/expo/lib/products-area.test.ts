import { describe, expect, it, vi } from 'vitest';
import type { ProductTraits, VariantSummary } from '@tallyui/core';
import {
  filterProductAreaRows, filterProductAreaRowsByCategory, filterProductAreaRowsByTag, filterProductAreaRowsInStock,
  filterProductAreaRowsOnSale, listProductTags, loadProductsAreaCategory, loadProductsAreaTag, productAreaItems, productAreaProducts, productAreaRows,
  productAreaStockLine, productTags, PRODUCTS_VARIATIONS, saveProductsAreaCategory,
  saveProductsAreaTag, STOCK_STATUS_DOTS, type ProductAreaItem, type ProductAreaRow,
} from './products-area';
import type { SessionStorage } from './session';

type Doc = { id: string; title: string; variants: VariantSummary[]; categories?: { id: string; name: string }[]; thumbnail?: string;
  tags?: unknown };
const traits = {
  getName: (doc: Doc) => doc.title,
  getImageUrl: (doc: Doc) => doc.thumbnail,
  getVariantCount: (doc: Doc) => doc.variants.length,
  getVariants: (doc: Doc) => doc.variants,
  getCategories: (doc: Doc) => doc.categories ?? [],
  getCategoryNames: (doc: Doc) => (doc.categories ?? []).map((category) => category.name),
} as unknown as ProductTraits;
const eur = (amount: number) => [{ amount, currency: 'EUR', kind: 'base' as const }];

describe('productAreaRows', () => {
  it('gives one row per variant: name, SKU, price and stock quantity', () => {
    const shirt: Doc = { id: 'shirt', title: 'Shirt', variants: [
      { id: 'shirt-one', title: 'One size', sku: 'SHIRT', barcode: '5012345678900', prices: eur(1250),
        stock: { status: 'in_stock', quantity: 7 } },
    ] };
    const mug: Doc = { id: 'mug', title: 'Mug', variants: [
      { id: 'mug-a', title: 'A', sku: 'MUG-A', prices: eur(500), stock: { status: 'in_stock', quantity: 3 } },
      { id: 'mug-b', title: 'B', sku: 'MUG-B', prices: eur(600), stock: { status: 'out_of_stock', quantity: 0 } },
    ] };
    expect(productAreaRows([shirt, mug], traits, 'EUR')).toEqual([
      { id: 'shirt-one', name: 'Shirt', sku: 'SHIRT', barcode: '5012345678900', price: '€12.50', stock: '7', stockStatus: 'in_stock',
        categories: '', categoryIds: [], tagIds: [], regularPrice: '€12.50', salePrice: '', onSale: false },
      { id: 'mug-a', name: 'Mug · A', sku: 'MUG-A', barcode: '', price: '€5.00', stock: '3', stockStatus: 'in_stock', categories: '',
        categoryIds: [], tagIds: [], regularPrice: '€5.00', salePrice: '', onSale: false },
      { id: 'mug-b', name: 'Mug · B', sku: 'MUG-B', barcode: '', price: '€6.00', stock: '0', stockStatus: 'out_of_stock', categories: '',
        categoryIds: [], tagIds: [], regularPrice: '€6.00', salePrice: '', onSale: false },
    ]);
  });

  it('labels untracked stock by status', () => {
    const statuses = ['in_stock', 'out_of_stock', 'backorder', 'unknown'] as const;
    const doc: Doc = { id: 'p', title: 'P', variants: statuses.map((status) => ({ id: status, title: status, sku: status,
      prices: eur(100), stock: { status } })) };
    expect(productAreaRows([doc], traits, 'EUR').map((row) => row.stock))
      .toEqual(['In stock', 'Out of stock', 'On backorder', '—']);
  });

  it('shows a missing SKU as empty and a missing price as a dash', () => {
    const doc: Doc = { id: 'p', title: 'Plain', variants: [{ id: 'v', prices: [], stock: { status: 'unknown' } }] };
    expect(productAreaRows([doc], traits, 'EUR')).toEqual([{ id: 'v', name: 'Plain', sku: '', barcode: '', price: '—',
      stock: '—', stockStatus: 'unknown', categories: '', categoryIds: [], tagIds: [], regularPrice: '—', salePrice: '', onSale: false }]);
  });

  it("gives each row its stock status and its product's categories", () => {
    const both: Doc = { id: 'b', title: 'Both', categories: [{ id: 'c1', name: 'Drinks' }, { id: 'c2', name: 'Food' }], variants: [
      { id: 'b-1', prices: eur(100), stock: { status: 'backorder' } },
    ] };
    const none: Doc = { id: 'n', title: 'None', variants: [{ id: 'n-1', prices: eur(100), stock: { status: 'out_of_stock', quantity: 0 } }] };
    expect(productAreaRows([both, none], traits, 'EUR').map(({ id, stockStatus, categories, categoryIds }) =>
      ({ id, stockStatus, categories, categoryIds }))).toEqual([
      { id: 'b-1', stockStatus: 'backorder', categories: 'Drinks, Food', categoryIds: ['c1', 'c2'] },
      { id: 'n-1', stockStatus: 'out_of_stock', categories: '', categoryIds: [] },
    ]);
  });

  it("gives every variant row its product's thumbnail, and none without one", () => {
    const mug: Doc = { id: 'mug', title: 'Mug', thumbnail: 'https://img.test/mug.png', variants: [
      { id: 'mug-a', title: 'A', prices: eur(500), stock: { status: 'in_stock' } },
      { id: 'mug-b', title: 'B', prices: eur(600), stock: { status: 'in_stock' } },
    ] };
    const plain: Doc = { id: 'p', title: 'Plain', variants: [{ id: 'p-1', prices: eur(100), stock: { status: 'in_stock' } }] };
    expect(productAreaRows([mug, plain], traits, 'EUR').map(({ id, imageUrl }) => ({ id, imageUrl }))).toEqual([
      { id: 'mug-a', imageUrl: 'https://img.test/mug.png' },
      { id: 'mug-b', imageUrl: 'https://img.test/mug.png' },
      { id: 'p-1', imageUrl: undefined },
    ]);
    expect(productAreaRows([plain], traits, 'EUR')[0].imageUrl).toBeUndefined();
  });

  it("gives a sale variant v2's regular price, its sale price and onSale; a base-only sibling has no sale", () => {
    const mug: Doc = { id: 'mug', title: 'Mug', variants: [
      { id: 'mug-a', title: 'A', prices: [{ amount: 1000, currency: 'EUR', kind: 'base' }, { amount: 800, currency: 'EUR', kind: 'sale' }],
        stock: { status: 'in_stock' } },
      { id: 'mug-b', title: 'B', prices: eur(600), stock: { status: 'in_stock' } },
    ] };
    expect(productAreaRows([mug], traits, 'EUR').map(({ id, price, regularPrice, salePrice, onSale }) =>
      ({ id, price, regularPrice, salePrice, onSale }))).toEqual([
      { id: 'mug-a', price: '€8.00', regularPrice: '€10.00', salePrice: '€8.00', onSale: true },
      { id: 'mug-b', price: '€6.00', regularPrice: '€6.00', salePrice: '', onSale: false },
    ]);
  });

  it('counts no sale for a sale entry not below the base, or one in another currency', () => {
    const doc: Doc = { id: 'p', title: 'P', variants: [
      { id: 'above', title: 'Above', prices: [{ amount: 1000, currency: 'EUR', kind: 'base' }, { amount: 1200, currency: 'EUR', kind: 'sale' }],
        stock: { status: 'in_stock' } },
      { id: 'usd', title: 'USD', prices: [{ amount: 1000, currency: 'EUR', kind: 'base' }, { amount: 800, currency: 'USD', kind: 'sale' }],
        stock: { status: 'in_stock' } },
    ] };
    expect(productAreaRows([doc], traits, 'EUR').map(({ id, price, regularPrice, salePrice, onSale }) =>
      ({ id, price, regularPrice, salePrice, onSale }))).toEqual([
      { id: 'above', price: '€10.00', regularPrice: '€10.00', salePrice: '', onSale: false },
      { id: 'usd', price: '€10.00', regularPrice: '€10.00', salePrice: '', onSale: false },
    ]);
  });
});

describe('productAreaStockLine', () => {
  const row = (stock: string, stockStatus: ProductAreaRow['stockStatus']): ProductAreaRow => ({ id: 'v', name: 'P', sku: 'P', barcode: '',
    price: '€1.00', stock, stockStatus, categories: '', categoryIds: [], tagIds: [], regularPrice: '€1.00', salePrice: '', onSale: false });

  it('puts the quantity before the status when the variant has one', () => {
    expect(productAreaStockLine(row('5', 'in_stock'))).toBe('5 · In stock');
    expect(productAreaStockLine(row('0', 'out_of_stock'))).toBe('0 · Out of stock');
  });

  it('gives the status alone with no quantity', () => {
    expect(productAreaStockLine(row('On backorder', 'backorder'))).toBe('On backorder');
    expect(productAreaStockLine(row('—', 'unknown'))).toBe('—');
  });
});

describe('filterProductAreaRows', () => {
  const row = (id: string, name: string, sku: string): ProductAreaRow => ({ id, name, sku, barcode: '', price: '€1.00', stock: '1',
    stockStatus: 'in_stock', categories: '', categoryIds: [], tagIds: [], regularPrice: '€1.00', salePrice: '', onSale: false });
  const rows = [row('1', 'E2E product 1', 'E2E-1'), row('4a', 'E2E product 4 · A', 'E2E-4'), row('4b', 'E2E product 4 · B', 'E2E-4B')];

  it('returns the same array for a blank query', () => {
    expect(filterProductAreaRows(rows, '')).toBe(rows);
    expect(filterProductAreaRows(rows, '   ')).toBe(rows);
  });

  it('matches by name', () => {
    expect(filterProductAreaRows(rows, 'product 1').map((r) => r.id)).toEqual(['1']);
  });

  it('matches by SKU, ignoring case', () => {
    expect(filterProductAreaRows(rows, 'e2e-4b').map((r) => r.id)).toEqual(['4b']);
  });

  it('requires every term', () => {
    expect(filterProductAreaRows(rows, 'product 4').map((r) => r.id)).toEqual(['4a', '4b']);
    expect(filterProductAreaRows(rows, '4 B').map((r) => r.id)).toEqual(['4b']);
  });

  it('gives [] with no match', () => {
    expect(filterProductAreaRows(rows, 'hat')).toEqual([]);
  });

  // v2: "finds products by name, SKU or barcode", so a scanned barcode finds its row.
  it('matches by barcode', () => {
    const scanned = [...rows, { ...row('2', 'E2E product 2', 'E2E-2'), barcode: '2000000000011' }];
    expect(filterProductAreaRows(scanned, '2000000000011').map((r) => r.id)).toEqual(['2']);
  });
});

describe('filterProductAreaRowsByCategory', () => {
  const row = (id: string, categoryIds: string[]): ProductAreaRow => ({ id, name: id, sku: id, barcode: '', price: '€1.00', stock: '1',
    stockStatus: 'in_stock', categories: '', categoryIds, tagIds: [], regularPrice: '€1.00', salePrice: '', onSale: false });
  const rows = [row('1', ['drinks']), row('2', ['drinks', 'food']), row('3', ['food']), row('4', [])];

  it('keeps only rows in the category', () => {
    expect(filterProductAreaRowsByCategory(rows, 'food').map((r) => r.id)).toEqual(['2', '3']);
    expect(filterProductAreaRowsByCategory(rows, 'drinks').map((r) => r.id)).toEqual(['1', '2']);
    expect(filterProductAreaRowsByCategory(rows, 'hats')).toEqual([]);
  });

  it('returns the same array for no category', () => {
    expect(filterProductAreaRowsByCategory(rows, null)).toBe(rows);
    expect(filterProductAreaRowsByCategory(rows, '')).toBe(rows);
  });
});

describe('STOCK_STATUS_DOTS', () => {
  it("colours the dot as TallyUI's ProductStockBadge does", () => {
    expect(STOCK_STATUS_DOTS.in_stock).toBe('bg-success');
    expect(STOCK_STATUS_DOTS.out_of_stock).toBe('bg-destructive');
  });
});

describe('filterProductAreaRowsInStock', () => {
  const row = (id: string, stockStatus: ProductAreaRow['stockStatus']): ProductAreaRow => ({ id, name: id, sku: id, barcode: '',
    price: '€1.00', stock: '1', stockStatus, categories: '', categoryIds: [], tagIds: [], regularPrice: '€1.00', salePrice: '', onSale: false });
  const rows = [row('in', 'in_stock'), row('back', 'backorder'), row('out', 'out_of_stock'), row('unknown', 'unknown')];

  it('returns the same array when off', () => {
    expect(filterProductAreaRowsInStock(rows, false)).toBe(rows);
  });

  it('keeps only in-stock rows when on', () => {
    expect(filterProductAreaRowsInStock(rows, true).map((r) => r.id)).toEqual(['in']);
  });
});

describe('filterProductAreaRowsOnSale', () => {
  const mug: Doc = { id: 'mug', title: 'Mug', variants: [
    { id: 'mug-a', title: 'A', prices: [{ amount: 1000, currency: 'EUR', kind: 'base' }, { amount: 800, currency: 'EUR', kind: 'sale' }],
      stock: { status: 'in_stock' } },
    { id: 'mug-b', title: 'B', prices: eur(600), stock: { status: 'in_stock' } },
  ] };
  const rows = productAreaRows([mug], traits, 'EUR');

  it('returns the same array when off', () => {
    expect(filterProductAreaRowsOnSale(rows, false)).toBe(rows);
  });

  it('keeps only rows on sale when on', () => {
    expect(filterProductAreaRowsOnSale(rows, true).map((r) => r.id)).toEqual(['mug-a']);
  });
});

describe('loadProductsAreaCategory / saveProductsAreaCategory', () => {
  const memory = (): SessionStorage & { data: Map<string, string> } => {
    const data = new Map<string, string>();
    return { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); },
      removeItem: (key) => { data.delete(key); } };
  };
  const store = 'https://store.test';

  it('round-trips a saved category id', () => {
    const storage = memory();
    saveProductsAreaCategory(storage, store, 'cat_food');
    expect(loadProductsAreaCategory(storage, store)).toBe('cat_food');
  });

  it('loads a saved null (All products) as null', () => {
    const storage = memory();
    saveProductsAreaCategory(storage, store, 'cat_food');
    saveProductsAreaCategory(storage, store, null);
    expect(loadProductsAreaCategory(storage, store)).toBeNull();
  });

  it('keeps the choice per store', () => {
    const storage = memory();
    saveProductsAreaCategory(storage, store, 'cat_food');
    expect(loadProductsAreaCategory(storage, 'https://other.test')).toBeNull();
  });

  it('loads missing, corrupt and wrong-shaped values as null', () => {
    const storage = memory();
    expect(loadProductsAreaCategory(storage, store)).toBeNull();
    for (const value of ['{', '[]', JSON.stringify({ category: 7 }), JSON.stringify({ category: '' })]) {
      storage.data.set('medusapos.products-area.' + store, value);
      expect(loadProductsAreaCategory(storage, store)).toBeNull();
    }
  });

  it('loads null from a null storage, and saving to it does nothing', () => {
    expect(loadProductsAreaCategory(null, store)).toBeNull();
    expect(() => saveProductsAreaCategory(null, store, 'cat_food')).not.toThrow();
  });

  it('loads null when getItem throws, and swallows a throwing setItem', () => {
    const fail = () => { throw new Error('denied'); };
    const broken: SessionStorage = { getItem: fail, setItem: fail, removeItem: fail };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(loadProductsAreaCategory(broken, store)).toBeNull();
    expect(() => saveProductsAreaCategory(broken, store, 'cat_food')).not.toThrow();
    expect(warn).toHaveBeenCalledWith('Could not save the Products category:', expect.any(Error));
    warn.mockRestore();
  });
});

describe('productTags', () => {
  it("keeps the document's valid { id, value } tags", () => {
    expect(productTags({ tags: [{ id: 't1', value: 'Organic', created_at: 'x' }, { id: 't2', value: 'Seasonal' }] }))
      .toEqual([{ id: 't1', value: 'Organic' }, { id: 't2', value: 'Seasonal' }]);
  });

  it('gives [] for no tags, a non-array or a null document', () => {
    expect(productTags({})).toEqual([]);
    for (const tags of ['Organic', null]) expect(productTags({ tags })).toEqual([]);
    expect(productTags(null)).toEqual([]);
  });

  it('drops entries with a missing or empty id or value', () => {
    expect(productTags({ tags: [null, 'Organic', { value: 'A' }, { id: '', value: 'B' }, { id: 'c' }, { id: 'd', value: '' },
      { id: 7, value: 'E' }, { id: 'f', value: 'Fine' }] })).toEqual([{ id: 'f', value: 'Fine' }]);
  });
});

describe('productAreaRows tags', () => {
  it("gives every variant row of a tagged product its tag ids, and [] to an untagged product's", () => {
    const mug: Doc = { id: 'mug', title: 'Mug', tags: [{ id: 't1', value: 'Organic' }, { id: 't2', value: 'Seasonal' }], variants: [
      { id: 'mug-a', title: 'A', prices: eur(500), stock: { status: 'in_stock' } },
      { id: 'mug-b', title: 'B', prices: eur(600), stock: { status: 'in_stock' } },
    ] };
    const plain: Doc = { id: 'p', title: 'Plain', variants: [{ id: 'p-1', prices: eur(100), stock: { status: 'in_stock' } }] };
    expect(productAreaRows([mug, plain], traits, 'EUR').map(({ id, tagIds }) => ({ id, tagIds }))).toEqual([
      { id: 'mug-a', tagIds: ['t1', 't2'] }, { id: 'mug-b', tagIds: ['t1', 't2'] }, { id: 'p-1', tagIds: [] },
    ]);
  });
});

describe('listProductTags', () => {
  it('lists each tag once by id, the first value seen, sorted by value naturally then by id', () => {
    expect(listProductTags([
      { tags: [{ id: 't10', value: 'Size 10' }, { id: 'tb', value: 'organic' }] },
      { tags: [{ id: 't2', value: 'Size 2' }, { id: 'tb', value: 'Renamed' }, { id: 'ta', value: 'Organic' }] },
      { title: 'untagged' }, { tags: [] },
    ])).toEqual([
      { id: 'ta', value: 'Organic' }, { id: 'tb', value: 'organic' }, { id: 't2', value: 'Size 2' }, { id: 't10', value: 'Size 10' },
    ]);
  });
});

describe('filterProductAreaRowsByTag', () => {
  const row = (id: string, tagIds: string[]): ProductAreaRow => ({ id, name: id, sku: id, barcode: '', price: '€1.00', stock: '1',
    stockStatus: 'in_stock', categories: '', categoryIds: [], tagIds, regularPrice: '€1.00', salePrice: '', onSale: false });
  const rows = [row('1', ['organic']), row('2', ['organic', 'seasonal']), row('3', ['seasonal']), row('4', [])];

  it('returns the same array for no tag', () => {
    expect(filterProductAreaRowsByTag(rows, null)).toBe(rows);
    expect(filterProductAreaRowsByTag(rows, '')).toBe(rows);
  });

  it('keeps only rows carrying the tag', () => {
    expect(filterProductAreaRowsByTag(rows, 'organic').map((r) => r.id)).toEqual(['1', '2']);
    expect(filterProductAreaRowsByTag(rows, 'seasonal').map((r) => r.id)).toEqual(['2', '3']);
    expect(filterProductAreaRowsByTag(rows, 'gone')).toEqual([]);
  });
});

describe('loadProductsAreaTag / saveProductsAreaTag', () => {
  const memory = (): SessionStorage & { data: Map<string, string> } => {
    const data = new Map<string, string>();
    return { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); },
      removeItem: (key) => { data.delete(key); } };
  };
  const store = 'https://store.test';

  it('round-trips a saved tag per store, and a saved null as null', () => {
    const storage = memory();
    saveProductsAreaTag(storage, store, 'ptag_organic');
    expect(loadProductsAreaTag(storage, store)).toBe('ptag_organic');
    expect(loadProductsAreaTag(storage, 'https://other.test')).toBeNull();
    expect(storage.data.get('medusapos.products-area-tag.' + store)).toBe(JSON.stringify({ tag: 'ptag_organic' }));
    saveProductsAreaTag(storage, store, null);
    expect(loadProductsAreaTag(storage, store)).toBeNull();
  });

  it('loads missing, corrupt and wrong-shaped values as null', () => {
    const storage = memory();
    expect(loadProductsAreaTag(storage, store)).toBeNull();
    for (const value of ['{', '[]', 'null', '"ptag"', JSON.stringify({ tag: 7 }), JSON.stringify({ tag: '' })]) {
      storage.data.set('medusapos.products-area-tag.' + store, value);
      expect(loadProductsAreaTag(storage, store)).toBeNull();
    }
  });

  it('keeps the tag and the category apart', () => {
    const storage = memory();
    saveProductsAreaCategory(storage, store, 'cat_food');
    saveProductsAreaTag(storage, store, 'ptag_organic');
    expect(loadProductsAreaCategory(storage, store)).toBe('cat_food');
    expect(storage.data.get('medusapos.products-area.' + store)).toBe(JSON.stringify({ category: 'cat_food' }));
    saveProductsAreaCategory(storage, store, null);
    expect(loadProductsAreaTag(storage, store)).toBe('ptag_organic');
  });

  it('loads null from a null or throwing storage, and swallows a throwing setItem', () => {
    const fail = () => { throw new Error('denied'); };
    const broken: SessionStorage = { getItem: fail, setItem: fail, removeItem: fail };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(loadProductsAreaTag(null, store)).toBeNull();
    expect(() => saveProductsAreaTag(null, store, 'ptag_organic')).not.toThrow();
    expect(loadProductsAreaTag(broken, store)).toBeNull();
    expect(() => saveProductsAreaTag(broken, store, 'ptag_organic')).not.toThrow();
    expect(warn).toHaveBeenCalledWith('Could not save the Products tag:', expect.any(Error));
    warn.mockRestore();
  });
});

// v2's Expanded rows: a product with several variants has a row of its own.
describe('productAreaProducts', () => {
  const shirt: Doc = { id: 'shirt', title: 'Shirt', variants: [
    { id: 'shirt-one', title: 'One size', sku: 'SHIRT', prices: eur(1250), stock: { status: 'in_stock', quantity: 7 } }] };
  const twoOf = (a: Partial<VariantSummary>, b: Partial<VariantSummary>): Doc => ({ id: 'mug', title: 'Mug', variants: [
    { id: 'mug-a', title: 'A', prices: eur(2000), stock: { status: 'in_stock', quantity: 3 }, ...a },
    { id: 'mug-b', title: 'B', prices: eur(2500), stock: { status: 'out_of_stock', quantity: 0 }, ...b }] });

  it('gives no entry for a single-variant product and one for a two-variant product, with the price range', () => {
    const mug: Doc = { ...twoOf({ sku: 'MUG-A' }, { sku: 'MUG-B' }), thumbnail: 'https://img.test/mug.png',
      categories: [{ id: 'c1', name: 'Kitchen' }], tags: [{ id: 'tag_a', value: 'A' }] };
    expect(productAreaProducts([shirt], traits, 'EUR')).toEqual([]);
    expect(productAreaProducts([shirt, mug], traits, 'EUR')).toEqual([{ id: 'mug', name: 'Mug', options: [],
      variants: [{ id: 'mug-a', title: 'A' }, { id: 'mug-b', title: 'B' }], sku: '', barcode: '', price: '€20.00 – €25.00',
      regularPrice: '€20.00 – €25.00', salePrice: '', onSale: false, stock: '3', stockStatus: 'in_stock', categories: 'Kitchen',
      categoryIds: ['c1'], tagIds: ['tag_a'], imageUrl: 'https://img.test/mug.png' }]);
  });

  it('gives one price when both variants cost the same, and a dash when none resolves', () => {
    expect(productAreaProducts([twoOf({ prices: eur(500) }, { prices: eur(500) })], traits, 'EUR')[0].price).toBe('€5.00');
    const none = productAreaProducts([twoOf({ prices: [] }, { prices: [] })], traits, 'EUR')[0];
    expect([none.price, none.regularPrice]).toEqual(['—', '—']);
  });

  it("ranges the regular price over each variant's price before a sale", () => {
    const onSale = [{ amount: 1000, currency: 'EUR', kind: 'base' as const }, { amount: 800, currency: 'EUR', kind: 'sale' as const }];
    const [mug] = productAreaProducts([twoOf({ prices: onSale }, { prices: eur(600) })], traits, 'EUR');
    expect([mug.price, mug.regularPrice, mug.salePrice, mug.onSale]).toEqual(['€6.00 – €8.00', '€6.00 – €10.00', '', false]);
  });

  it('gives one line per option group from getVariantOptions, none without it, and a variant id for an untitled variant', () => {
    const withOptions = { ...traits, getVariantOptions: () => [{ name: 'Size', values: ['S', 'M'] }, { name: 'Color', values: ['Blue', 'Red'] }] };
    expect(productAreaProducts([twoOf({}, {})], withOptions as ProductTraits, 'EUR')[0].options).toEqual(['Size: S, M', 'Color: Blue, Red']);
    const [mug] = productAreaProducts([twoOf({}, { title: undefined })], traits, 'EUR');
    expect([mug.options, mug.variants]).toEqual([[], [{ id: 'mug-a', title: 'A' }, { id: 'mug-b', title: 'mug-b' }]]);
  });

  it('sums the stock when every variant has a quantity, else shows the status label', () => {
    expect(productAreaProducts([twoOf({ stock: { status: 'in_stock', quantity: 2 } }, { stock: { status: 'in_stock', quantity: 5 } })],
      traits, 'EUR')[0].stock).toBe('7');
    expect(productAreaProducts([twoOf({ stock: { status: 'in_stock', quantity: 2 } }, { stock: { status: 'backorder' } })],
      traits, 'EUR')[0].stock).toBe('In stock');
  });

  it('is in stock if any variant is, else on backorder, else out of stock, else unknown', () => {
    const status = (a: VariantSummary['stock']['status'], b: VariantSummary['stock']['status']) =>
      productAreaProducts([twoOf({ stock: { status: a } }, { stock: { status: b } })], traits, 'EUR')[0].stockStatus;
    expect(status('backorder', 'in_stock')).toBe('in_stock');
    expect(status('out_of_stock', 'backorder')).toBe('backorder');
    expect(status('unknown', 'out_of_stock')).toBe('out_of_stock');
    expect(status('unknown', 'unknown')).toBe('unknown');
  });
});

describe('productAreaItems', () => {
  const shirt: Doc = { id: 'shirt', title: 'Shirt', variants: [
    { id: 'shirt-one', title: 'One size', sku: 'SHIRT', prices: eur(1250), stock: { status: 'in_stock', quantity: 7 } }] };
  const mug: Doc = { id: 'mug', title: 'Mug', variants: [
    { id: 'mug-a', title: 'A', sku: 'MUG-A', prices: eur(500), stock: { status: 'in_stock', quantity: 3 } },
    { id: 'mug-b', title: 'B', sku: 'MUG-B', prices: eur(600), stock: { status: 'out_of_stock', quantity: 0 } }] };
  const rows = productAreaRows([shirt, mug], traits, 'EUR');
  const products = productAreaProducts([shirt, mug], traits, 'EUR');
  const valueOf = (item: ProductAreaItem, field: string) =>
    field === 'name' ? (item.kind === 'product' ? item.name : item.label) : undefined;
  const asc = { field: 'name', dir: 'asc' } as const;
  const open = () => true;
  const closed = () => false;
  const ids = (items: ProductAreaItem[]) => items.map((item) => item.id);

  it('keeps a single-variant row as one item with its fields, sub false and its name as label', () => {
    expect(productAreaItems(rows, products, asc, open, valueOf).find((item) => item.id === 'shirt-one'))
      .toEqual({ ...rows[0], kind: 'variant', sub: false, label: 'Shirt' });
  });

  it('gives a closed product its row only, with the count shown', () => {
    const items = productAreaItems(rows, products, asc, closed, valueOf);
    expect(ids(items)).toEqual(['mug', 'shirt-one']);
    expect(items[0]).toMatchObject({ kind: 'product', name: 'Mug', shown: 2, open: false });
  });

  it("adds an open product's sub-rows after it, labelled by the variant title", () => {
    const items = productAreaItems(rows, products, asc, (id) => id === 'mug', valueOf);
    expect(ids(items)).toEqual(['mug', 'mug-a', 'mug-b', 'shirt-one']);
    expect(items[0]).toMatchObject({ kind: 'product', open: true });
    expect(items.slice(1, 3).map((item) => item.kind === 'variant' && [item.sub, item.label, item.sku]))
      .toEqual([[true, 'A', 'MUG-A'], [true, 'B', 'MUG-B']]);
  });

  it('lists only the shown variants under an open product, and leaves out a product with none shown', () => {
    const narrowed = productAreaItems(rows.filter((row) => row.id !== 'mug-a'), products, asc, open, valueOf);
    expect(ids(narrowed)).toEqual(['mug', 'mug-b', 'shirt-one']);
    expect(narrowed[0]).toMatchObject({ shown: 1 });
    expect(ids(productAreaItems(rows.filter((row) => row.id === 'shirt-one'), products, asc, open, valueOf))).toEqual(['shirt-one']);
  });

  it("sorts name descending with each product's sub-rows directly under it, descending among themselves", () => {
    expect(ids(productAreaItems(rows, products, { field: 'name', dir: 'desc' }, open, valueOf)))
      .toEqual(['shirt-one', 'mug', 'mug-b', 'mug-a']);
  });

  it('keeps catalogue order with no sort', () => {
    expect(ids(productAreaItems(rows, products, null, open, valueOf))).toEqual(['shirt-one', 'mug', 'mug-a', 'mug-b']);
  });
});

describe('PRODUCTS_VARIATIONS', () => {
  it('counts the variations, and how many of them the filters leave', () => {
    expect(PRODUCTS_VARIATIONS(2, 2)).toBe('2 variations');
    expect(PRODUCTS_VARIATIONS(1, 2)).toBe('1 of 2 variations');
    expect(PRODUCTS_VARIATIONS(1, 1)).toBe('1 variation');
  });
});
