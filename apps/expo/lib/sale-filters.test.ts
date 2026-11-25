import { medusaProductTraits } from '@tallyui/connector-medusa';
import type { ProductTraits } from '@tallyui/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isOnSale, loadSaleFilters, NO_SALE_FILTERS, saleFilterItems, saveSaleFilters, type SaleFilters } from './sale-filters';
import type { SessionStorage } from './session';

const traits = medusaProductTraits as ProductTraits<unknown>;
const store = 'https://store.test';
const key = `medusapos.sale-filters.${store}`;

function memory(entries: [string, string][] = []): SessionStorage & { data: Map<string, string> } {
  const data = new Map(entries);
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); }, removeItem: (k) => { data.delete(k); } };
}

describe('loadSaleFilters', () => {
  it('gives no picks for no storage, nothing stored, corrupt JSON, an array, null and a string', () => {
    expect(loadSaleFilters(null, store)).toEqual(NO_SALE_FILTERS);
    expect(loadSaleFilters(memory(), store)).toEqual(NO_SALE_FILTERS);
    for (const raw of ['{not json', '[true, "t1"]', 'null', '"t1"', '7']) {
      expect(loadSaleFilters(memory([[key, raw]]), store)).toEqual(NO_SALE_FILTERS);
    }
  });

  it('reads a stored choice back', () => {
    const picks: SaleFilters = { onSale: true, tag: 'ptag_organic', collection: 'pcol_featured' };
    const storage = memory();
    saveSaleFilters(storage, store, picks);
    expect(loadSaleFilters(storage, store)).toEqual(picks);
  });

  it('defaults each wrongly typed field on its own and keeps the others', () => {
    const load = (value: object) => loadSaleFilters(memory([[key, JSON.stringify(value)]]), store);
    const good = { onSale: true, tag: 't1', collection: 'c1' };
    expect(load({ ...good, onSale: 'yes' })).toEqual({ onSale: false, tag: 't1', collection: 'c1' });
    expect(load({ ...good, onSale: 1 })).toEqual({ onSale: false, tag: 't1', collection: 'c1' });
    expect(load({ ...good, tag: 7 })).toEqual({ onSale: true, tag: null, collection: 'c1' });
    expect(load({ ...good, tag: '' })).toEqual({ onSale: true, tag: null, collection: 'c1' });
    expect(load({ ...good, collection: { id: 'c1' } })).toEqual({ onSale: true, tag: 't1', collection: null });
    expect(load({ onSale: true })).toEqual({ onSale: true, tag: null, collection: null });
  });

  it('keeps two stores apart', () => {
    const storage = memory();
    saveSaleFilters(storage, store, { onSale: false, tag: 't1', collection: null });
    saveSaleFilters(storage, 'https://other.test', { onSale: true, tag: null, collection: 'c2' });
    expect(loadSaleFilters(storage, store)).toEqual({ onSale: false, tag: 't1', collection: null });
    expect(loadSaleFilters(storage, 'https://other.test')).toEqual({ onSale: true, tag: null, collection: 'c2' });
    expect([...storage.data.keys()].sort()).toEqual([`medusapos.sale-filters.https://other.test`, key]);
  });
});

describe('saveSaleFilters', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('warns and never throws when the storage throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const storage = { ...memory(), setItem: () => { throw new Error('QuotaExceededError'); } };
    expect(() => saveSaleFilters(storage, store, { onSale: true, tag: null, collection: null })).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(() => saveSaleFilters(null, store, NO_SALE_FILTERS)).not.toThrow();
  });
});

// A Medusa calculated price: `sale` below `amount` from a sale price list.
const priced = (amount: number, sale?: number, currency = 'eur') => ({ calculated_price: { currency_code: currency,
  original_amount: amount, calculated_amount: sale ?? amount, calculated_price: { price_list_type: sale === undefined ? null : 'sale' } } });
type Variant = Record<string, unknown>;
const product = (id: string, title: string, variants: Variant[], extra: Record<string, unknown> = {}) => ({ id, title, status: 'published',
  variants: variants.map((variant, i) => ({ id: `${id}-${i}`, title: `V${i}`, sku: `${id.toUpperCase()}-${i}`, ...priced(10), ...variant })), ...extra });

describe('isOnSale', () => {
  it('is true for a sale price, false for none', () => {
    expect(isOnSale(product('a', 'A', [priced(10, 8)]), traits, 'EUR')).toBe(true);
    expect(isOnSale(product('a', 'A', [priced(10)]), traits, 'EUR')).toBe(false);
    expect(isOnSale(product('a', 'A', [{ calculated_price: undefined, prices: [{ amount: 10, currency_code: 'eur' }] }]), traits, 'EUR')).toBe(false);
  });

  it('is true when only the second variant is on sale', () => {
    expect(isOnSale(product('a', 'A', [priced(10), priced(20, 15)]), traits, 'EUR')).toBe(true);
  });

  it('is false when the sale is in another currency only', () => {
    expect(isOnSale(product('a', 'A', [priced(10, 8, 'usd')]), traits, 'EUR')).toBe(false);
    expect(isOnSale(product('a', 'A', [priced(10, 8, 'usd')]), traits, 'USD')).toBe(true);
  });
});

describe('saleFilterItems', () => {
  const organic = { id: 'ptag_organic', value: 'Organic' };
  const seasonal = { id: 'ptag_seasonal', value: 'Seasonal' };
  const drinks = { id: 'pcat_drinks', name: 'Drinks' };
  const stock = (inventory_quantity: number, allow_backorder = false) => ({ manage_inventory: true, inventory_quantity, allow_backorder });
  // Apple: organic, on sale, Drinks, featured. Banana: organic, out of stock. Cherry: seasonal, backorder, on sale.
  // Date: organic, featured, unknown stock. Elder: nothing.
  const apple = product('apple', 'Apple', [{ ...priced(30, 25), ...stock(5) }], { tags: [organic], categories: [drinks], collection_id: 'pcol_featured' });
  const banana = product('banana', 'Banana', [{ ...priced(20), ...stock(0) }], { tags: [organic] });
  const cherry = product('cherry', 'Cherry', [{ ...priced(10, 9), ...stock(0, true) }], { tags: [seasonal], categories: [drinks] });
  const date = product('date', 'Date', [priced(40)], { tags: [organic, seasonal], collection_id: 'pcol_featured' });
  const elder = product('elder', 'Elder', [{ ...priced(50), ...stock(3) }]);
  const products = [elder, cherry, apple, date, banana];
  const none: SaleFilters = NO_SALE_FILTERS;
  const ids = (picks: Partial<SaleFilters>, more: Partial<Parameters<typeof saleFilterItems>[1]> = {}) =>
    saleFilterItems(products, { traits, currency: 'EUR', picks: { ...none, ...picks }, query: '', inStock: false,
      sort: { field: 'name', dir: 'asc' }, ...more }).map(({ id }) => id);

  it('lists everything, sorted, with no pick', () => {
    expect(ids({})).toEqual(['apple', 'banana', 'cherry', 'date', 'elder']);
  });

  it('narrows by each pick alone', () => {
    expect(ids({ onSale: true })).toEqual(['apple', 'cherry']);
    expect(ids({ tag: 'ptag_organic' })).toEqual(['apple', 'banana', 'date']);
    expect(ids({ tag: 'ptag_none' })).toEqual([]);
    expect(ids({ collection: 'pcol_featured' })).toEqual(['apple', 'date']);
  });

  it('ANDs the picks with each other', () => {
    expect(ids({ onSale: true, tag: 'ptag_organic' })).toEqual(['apple']);
    expect(ids({ tag: 'ptag_seasonal', collection: 'pcol_featured' })).toEqual(['date']);
    expect(ids({ onSale: true, tag: 'ptag_organic', collection: 'pcol_featured' })).toEqual(['apple']);
    expect(ids({ onSale: true, tag: 'ptag_seasonal', collection: 'pcol_featured' })).toEqual([]);
  });

  it('applies a listed category, and ignores one no product is in', () => {
    expect(ids({ onSale: true }, { categoryId: 'pcat_drinks' })).toEqual(['apple', 'cherry']);
    expect(ids({ tag: 'ptag_seasonal' }, { categoryId: 'pcat_drinks' })).toEqual(['cherry']);
    expect(ids({ tag: 'ptag_seasonal' }, { categoryId: 'pcat_gone' })).toEqual(['cherry', 'date']);
    expect(ids({ tag: 'ptag_seasonal' }, { categoryId: null })).toEqual(['cherry', 'date']);
  });

  it('applies the search by name and by SKU', () => {
    expect(ids({ tag: 'ptag_organic' }, { query: 'an' })).toEqual(['banana']);
    expect(ids({ tag: 'ptag_organic' }, { query: '  DATE-0 ' })).toEqual(['date']);
    expect(ids({ tag: 'ptag_organic' }, { query: 'cherry' })).toEqual([]);
  });

  it('In Stock drops out of stock and backorder and keeps unknown', () => {
    expect(ids({ tag: 'ptag_organic' }, { inStock: true })).toEqual(['apple', 'date']);
    expect(ids({ onSale: true }, { inStock: true })).toEqual(['apple']);
    expect(ids({ tag: 'ptag_seasonal' }, { inStock: true })).toEqual(['date']);
  });

  it('sorts as asked', () => {
    expect(ids({ tag: 'ptag_organic' }, { sort: { field: 'name', dir: 'desc' } })).toEqual(['date', 'banana', 'apple']);
    expect(ids({ tag: 'ptag_organic' }, { sort: { field: 'price', dir: 'asc' } })).toEqual(['banana', 'apple', 'date']);
  });

  it('returns a new array and leaves the input untouched', () => {
    const input = [...products];
    const before = JSON.stringify(input);
    const out = saleFilterItems(input, { traits, currency: 'EUR', picks: none, query: '', inStock: false, sort: { field: 'name', dir: 'asc' } });
    expect(out).not.toBe(input);
    expect(input.map(({ id }) => id)).toEqual(['elder', 'cherry', 'apple', 'date', 'banana']);
    expect(JSON.stringify(input)).toBe(before);
    expect(out[0]).toBe(apple);
  });
});
