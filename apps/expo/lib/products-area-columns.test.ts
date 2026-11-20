import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PRODUCTS_AREA_COLUMN_ORDER, DEFAULT_PRODUCTS_AREA_COLUMNS, loadProductsAreaColumnOrder, loadProductsAreaColumns,
  moveProductsAreaColumn, PRODUCTS_AREA_COLUMNS, PRODUCTS_AREA_PRODUCT_LINES, productsAreaDropIndex, saveProductsAreaColumns,
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

const ORDER_KEY = 'medusapos.products-area-column-order.https://a.test';

describe('products-area column order', () => {
  it("starts in v2's order, Product after ID", () => {
    expect(DEFAULT_PRODUCTS_AREA_COLUMN_ORDER)
      .toEqual(['image', 'id', 'name', 'type', 'sku', 'barcode', 'stock', 'stockStatus', 'category', 'price', 'regularPrice', 'salePrice']);
  });

  it('reads a saved order back for its store and not for another store', () => {
    const order = ['price', 'image', 'id', 'name', 'type', 'sku', 'barcode', 'stock', 'stockStatus', 'category', 'regularPrice', 'salePrice'];
    const storage = fakeStorage({ [ORDER_KEY]: JSON.stringify(order) });
    expect(loadProductsAreaColumnOrder(storage, 'https://a.test')).toEqual(order);
    expect(loadProductsAreaColumnOrder(storage, 'https://b.test')).toEqual(DEFAULT_PRODUCTS_AREA_COLUMN_ORDER);
  });

  it('drops unknown ids and duplicates, and puts a missing id back at its default place', () => {
    // Stock first, Price before Product; 'variations' is unknown, SKU repeats, Barcode is missing.
    const stored = ['stock', 'variations', 'image', 'id', 'price', 'name', 'sku', 'type', 'sku', 'stockStatus', 'category', 'regularPrice', 'salePrice'];
    expect(loadProductsAreaColumnOrder(fakeStorage({ [ORDER_KEY]: JSON.stringify(stored) }), 'https://a.test'))
      .toEqual(['stock', 'image', 'id', 'price', 'name', 'barcode', 'sku', 'type', 'stockStatus', 'category', 'regularPrice', 'salePrice']);
    // An order saved before Regular price and Sale price existed: both come back at their default places, the end.
    const older = ['price', 'image', 'id', 'name', 'type', 'sku', 'barcode', 'stock', 'stockStatus', 'category'];
    expect(loadProductsAreaColumnOrder(fakeStorage({ [ORDER_KEY]: JSON.stringify(older) }), 'https://a.test'))
      .toEqual([...older, 'regularPrice', 'salePrice']);
  });

  it.each([
    ['nothing stored', undefined],
    ['unparsable JSON', '[not json'],
    ['an object', JSON.stringify({ 0: 'price' })],
    ['a string', JSON.stringify('price')],
  ])('gives the default order on %s', (_, raw) => {
    const storage = fakeStorage(raw === undefined ? {} : { [ORDER_KEY]: raw });
    expect(loadProductsAreaColumnOrder(storage, 'https://a.test')).toEqual(DEFAULT_PRODUCTS_AREA_COLUMN_ORDER);
  });

  it('moves a column up, down, and clamps the target to the list', () => {
    const order = DEFAULT_PRODUCTS_AREA_COLUMN_ORDER;
    expect(moveProductsAreaColumn(order, 'price', 3))
      .toEqual(['image', 'id', 'name', 'price', 'type', 'sku', 'barcode', 'stock', 'stockStatus', 'category', 'regularPrice', 'salePrice']);
    expect(moveProductsAreaColumn(order, 'image', 2))
      .toEqual(['id', 'name', 'image', 'type', 'sku', 'barcode', 'stock', 'stockStatus', 'category', 'price', 'regularPrice', 'salePrice']);
    expect(moveProductsAreaColumn(order, 'sku', -4)[0]).toBe('sku');
    expect(moveProductsAreaColumn(order, 'sku', 99)[order.length - 1]).toBe('sku');
    expect(moveProductsAreaColumn(order, 'sku', 99)).toHaveLength(order.length);
    expect(order).toEqual(DEFAULT_PRODUCTS_AREA_COLUMN_ORDER);
  });

  it('returns the order unchanged for an unknown id', () => {
    const order = ['image', 'name', 'sku'] as const;
    expect(moveProductsAreaColumn([...order], 'price', 0)).toEqual([...order]);
  });

  // Five 40-high rows from y 0; centres at 20, 60, 100, 140, 180.
  const rows = [0, 40, 80, 120, 160].map((y) => ({ y, height: 40 }));
  it('lands a dragged row past every centre its own moved centre has passed', () => {
    // Row 1 (centre 60) dragged down 85 to 145: past rows 2 and 3, it lands at index 3.
    expect(productsAreaDropIndex(rows, 1, 85)).toBe(3);
    // Row 3 (centre 140) dragged up 45 to 95: past row 2, it lands at index 2.
    expect(productsAreaDropIndex(rows, 3, -45)).toBe(2);
    // Row 2 (centre 100) nudged 15 either way passes no centre: it stays at index 2.
    expect(productsAreaDropIndex(rows, 2, 15)).toBe(2);
    expect(productsAreaDropIndex(rows, 2, -15)).toBe(2);
  });

  it('measures a taller row (Product with its sub-switches) by its own centre', () => {
    const mixed = [{ y: 0, height: 40 }, { y: 40, height: 160 }, { y: 200, height: 40 }];
    // Row 2 (centre 220) dragged up 110 to 110: past Product's centre (120), so it lands at index 1.
    expect(productsAreaDropIndex(mixed, 2, -110)).toBe(1);
    expect(productsAreaDropIndex(mixed, 2, -90)).toBe(2);
  });
});
