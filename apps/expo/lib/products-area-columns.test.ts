import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PRODUCTS_AREA_COLUMNS, loadProductsAreaColumns, PRODUCTS_AREA_COLUMNS, PRODUCTS_AREA_PRODUCT_LINES, saveProductsAreaColumns,
} from './products-area-columns';

function fakeStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  };
}

const KEY = 'medusapos.products-area-columns.https://a.test';
// Type and the Product sub-switches, all off.
const NEW_OFF = { type: false, productSku: false, productBarcode: false, productAttributes: false };

describe('products-area-columns', () => {
  it("lists the switches in v2's order", () => {
    expect(PRODUCTS_AREA_COLUMNS.map((column) => column.id))
      .toEqual(['image', 'id', 'type', 'sku', 'barcode', 'stock', 'stockStatus', 'category', 'price', 'regularPrice', 'salePrice']);
  });

  it('starts with Image on, ID and Barcode off and the other columns on, as v2', () => {
    expect(DEFAULT_PRODUCTS_AREA_COLUMNS)
      .toEqual({ image: true, id: false, type: false, sku: true, barcode: false, stock: true, stockStatus: true, category: true, price: true,
        regularPrice: false, salePrice: false, productSku: false, productBarcode: false, productAttributes: false });
  });

  it('loads a choice stored before ID and Barcode existed, with both off', () => {
    const old = { sku: false, stock: true, stockStatus: true, category: true, price: true };
    expect(loadProductsAreaColumns(fakeStorage({ [KEY]: JSON.stringify(old) }), 'https://a.test'))
      .toEqual({ ...old, image: true, id: false, barcode: false, regularPrice: false, salePrice: false, ...NEW_OFF });
  });

  it('loads a choice stored before Image existed, with Image on and the stored values kept', () => {
    const old = { id: true, sku: false, barcode: true, stock: true, stockStatus: false, category: true, price: true };
    expect(loadProductsAreaColumns(fakeStorage({ [KEY]: JSON.stringify(old) }), 'https://a.test'))
      .toEqual({ ...old, image: true, regularPrice: false, salePrice: false, ...NEW_OFF });
  });

  it('returns the defaults when nothing is stored', () => {
    expect(loadProductsAreaColumns(fakeStorage(), 'https://a.test')).toEqual(DEFAULT_PRODUCTS_AREA_COLUMNS);
    expect(loadProductsAreaColumns(null, 'https://a.test')).toEqual(DEFAULT_PRODUCTS_AREA_COLUMNS);
  });

  it('round-trips a saved value, every column off included', () => {
    const storage = fakeStorage();
    const settings = { image: true, id: true, sku: false, barcode: true, stock: true, stockStatus: false, category: true, price: false,
      regularPrice: true, salePrice: false, type: true, productSku: false, productBarcode: true, productAttributes: true };
    saveProductsAreaColumns(storage, 'https://a.test', settings);
    expect(loadProductsAreaColumns(storage, 'https://a.test')).toEqual(settings);
    const none = { image: false, id: false, sku: false, barcode: false, stock: false, stockStatus: false, category: false, price: false,
      regularPrice: false, salePrice: false, ...NEW_OFF };
    saveProductsAreaColumns(storage, 'https://a.test', none);
    expect(loadProductsAreaColumns(storage, 'https://a.test')).toEqual(none);
  });

  it('ends the list with Price, Regular price and Sale price, both new switches off by default and in older stored choices', () => {
    expect(PRODUCTS_AREA_COLUMNS.slice(-3).map((column) => column.label)).toEqual(['Price', 'Regular price', 'Sale price']);
    expect(DEFAULT_PRODUCTS_AREA_COLUMNS.regularPrice).toBe(false);
    expect(DEFAULT_PRODUCTS_AREA_COLUMNS.salePrice).toBe(false);
    expect(loadProductsAreaColumns(fakeStorage({ [KEY]: JSON.stringify({ price: false }) }), 'https://a.test'))
      .toMatchObject({ price: false, regularPrice: false, salePrice: false });
    expect(loadProductsAreaColumns(fakeStorage({ [KEY]: JSON.stringify({ regularPrice: true, salePrice: true }) }), 'https://a.test'))
      .toMatchObject({ regularPrice: true, salePrice: true });
  });

  it("lists the Product sub-switches SKU, Barcode and Attributes, and starts Type and all three off", () => {
    expect(PRODUCTS_AREA_PRODUCT_LINES.map((line) => [line.id, line.label]))
      .toEqual([['productSku', 'SKU'], ['productBarcode', 'Barcode'], ['productAttributes', 'Attributes']]);
    expect(PRODUCTS_AREA_COLUMNS.find((column) => column.id === 'type')?.label).toBe('Type');
    expect(DEFAULT_PRODUCTS_AREA_COLUMNS).toMatchObject(NEW_OFF);
  });

  it('loads a choice stored before Type and the Product sub-switches existed with all four off and its stored values kept', () => {
    const old = { image: false, id: true, sku: false, barcode: true, stock: true, stockStatus: false, category: true, price: false,
      regularPrice: true, salePrice: true };
    expect(loadProductsAreaColumns(fakeStorage({ [KEY]: JSON.stringify(old) }), 'https://a.test')).toEqual({ ...old, ...NEW_OFF });
    const on = { ...old, type: true, productSku: true, productBarcode: false, productAttributes: true };
    expect(loadProductsAreaColumns(fakeStorage({ [KEY]: JSON.stringify(on) }), 'https://a.test')).toEqual(on);
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
