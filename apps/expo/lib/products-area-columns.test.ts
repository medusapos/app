import { describe, expect, it } from 'vitest';
import { DEFAULT_PRODUCTS_AREA_COLUMNS, loadProductsAreaColumns, saveProductsAreaColumns } from './products-area-columns';

function fakeStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  };
}

const KEY = 'medusapos.products-area-columns.https://a.test';

describe('products-area-columns', () => {
  it('returns the defaults when nothing is stored', () => {
    expect(loadProductsAreaColumns(fakeStorage(), 'https://a.test')).toEqual(DEFAULT_PRODUCTS_AREA_COLUMNS);
    expect(loadProductsAreaColumns(null, 'https://a.test')).toEqual(DEFAULT_PRODUCTS_AREA_COLUMNS);
  });

  it('round-trips a saved value, every column off included', () => {
    const storage = fakeStorage();
    const settings = { sku: false, stock: true, stockStatus: false, category: true, price: false };
    saveProductsAreaColumns(storage, 'https://a.test', settings);
    expect(loadProductsAreaColumns(storage, 'https://a.test')).toEqual(settings);
    const none = { sku: false, stock: false, stockStatus: false, category: false, price: false };
    saveProductsAreaColumns(storage, 'https://a.test', none);
    expect(loadProductsAreaColumns(storage, 'https://a.test')).toEqual(none);
  });

  it('keeps the other defaults for a partial stored value', () => {
    expect(loadProductsAreaColumns(fakeStorage({ [KEY]: JSON.stringify({ price: false }) }), 'https://a.test'))
      .toEqual({ ...DEFAULT_PRODUCTS_AREA_COLUMNS, price: false });
  });

  it.each([
    ['unparsable JSON', '{not json'],
    ['an array', JSON.stringify([])],
    ['an unknown column', JSON.stringify({ variations: false })],
    ['a non-boolean value', JSON.stringify({ sku: 'no' })],
  ])('returns the defaults on %s', (_, raw) => {
    expect(loadProductsAreaColumns(fakeStorage({ [KEY]: raw }), 'https://a.test')).toEqual(DEFAULT_PRODUCTS_AREA_COLUMNS);
  });

  it('keeps each store its own choice', () => {
    const storage = fakeStorage();
    saveProductsAreaColumns(storage, 'https://a.test', { ...DEFAULT_PRODUCTS_AREA_COLUMNS, sku: false });
    expect(loadProductsAreaColumns(storage, 'https://b.test')).toEqual(DEFAULT_PRODUCTS_AREA_COLUMNS);
    expect(loadProductsAreaColumns(storage, 'https://a.test')).toEqual({ ...DEFAULT_PRODUCTS_AREA_COLUMNS, sku: false });
  });
});
