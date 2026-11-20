import { useCallback, useEffect, useState } from 'react';
import type { SessionStorage } from './session';

// The Products table's optional columns, in v2's order (Image first); the Product (name) column always shows.
export type ProductsAreaColumn = 'image' | 'id' | 'type' | 'sku' | 'barcode' | 'stock' | 'stockStatus' | 'category' | 'price'
  | 'regularPrice' | 'salePrice';
export const PRODUCTS_AREA_COLUMNS: { id: ProductsAreaColumn; label: string }[] = [
  { id: 'image', label: 'Image' }, { id: 'id', label: 'ID' }, { id: 'type', label: 'Type' }, { id: 'sku', label: 'SKU' },
  { id: 'barcode', label: 'Barcode' }, { id: 'stock', label: 'Stock' },
  { id: 'stockStatus', label: 'Stock status' }, { id: 'category', label: 'Category' }, { id: 'price', label: 'Price' },
  { id: 'regularPrice', label: 'Regular price' }, { id: 'salePrice', label: 'Sale price' },
];
// v2's sub-switches under Product: extra lines in a variant row's Product cell, apart from the SKU and Barcode columns.
export type ProductsAreaProductLine = 'productSku' | 'productBarcode' | 'productAttributes';
export const PRODUCTS_AREA_PRODUCT_LINES: { id: ProductsAreaProductLine; label: string }[] = [
  { id: 'productSku', label: 'SKU' }, { id: 'productBarcode', label: 'Barcode' }, { id: 'productAttributes', label: 'Attributes' },
];
export type ProductsAreaColumnSettings = Record<ProductsAreaColumn | ProductsAreaProductLine, boolean>;
// v2's Products table starts with Image on, ID, Type, Barcode, Regular price, Sale price and the Product lines off, the rest on.
export const DEFAULT_PRODUCTS_AREA_COLUMNS: ProductsAreaColumnSettings = {
  image: true, id: false, type: false, sku: true, barcode: false, stock: true, stockStatus: true, category: true, price: true,
  regularPrice: false, salePrice: false, productSku: false, productBarcode: false, productAttributes: false,
};
const PREFIX = 'medusapos.products-area-columns.';

export function loadProductsAreaColumns(storage: SessionStorage | null, baseUrl: string): ProductsAreaColumnSettings {
  try {
    const value: unknown = JSON.parse(storage?.getItem(PREFIX + baseUrl) ?? 'null');
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return DEFAULT_PRODUCTS_AREA_COLUMNS;
    const valid = Object.entries(value).every(([id, on]) =>
      [...PRODUCTS_AREA_COLUMNS, ...PRODUCTS_AREA_PRODUCT_LINES].some((column) => column.id === id) && typeof on === 'boolean');
    return valid ? { ...DEFAULT_PRODUCTS_AREA_COLUMNS, ...(value as Partial<ProductsAreaColumnSettings>) } : DEFAULT_PRODUCTS_AREA_COLUMNS;
  } catch { return DEFAULT_PRODUCTS_AREA_COLUMNS; }
}

// Every switch may be off: the Product column still shows.
export function saveProductsAreaColumns(storage: SessionStorage | null, baseUrl: string, settings: ProductsAreaColumnSettings): void {
  storage?.setItem(PREFIX + baseUrl, JSON.stringify(settings));
}

// The table's column order, Product included, kept apart from the switches: v2's order, Product after ID.
export type ProductsAreaOrderedColumn = ProductsAreaColumn | 'name';
export const DEFAULT_PRODUCTS_AREA_COLUMN_ORDER: ProductsAreaOrderedColumn[] = [
  'image', 'id', 'name', 'type', 'sku', 'barcode', 'stock', 'stockStatus', 'category', 'price', 'regularPrice', 'salePrice',
];
const ORDER_PREFIX = 'medusapos.products-area-column-order.';

// Known ids in stored order, without repeats; a missing one (a column added later) goes back at its default index.
export function loadProductsAreaColumnOrder(storage: SessionStorage | null, baseUrl: string): ProductsAreaOrderedColumn[] {
  try {
    const value: unknown = JSON.parse(storage?.getItem(ORDER_PREFIX + baseUrl) ?? 'null');
    if (!Array.isArray(value)) return DEFAULT_PRODUCTS_AREA_COLUMN_ORDER;
    const order = DEFAULT_PRODUCTS_AREA_COLUMN_ORDER.filter((id) => value.includes(id))
      .sort((a, b) => value.indexOf(a) - value.indexOf(b));
    DEFAULT_PRODUCTS_AREA_COLUMN_ORDER.forEach((id, index) => { if (!order.includes(id)) order.splice(index, 0, id); });
    return order;
  } catch { return DEFAULT_PRODUCTS_AREA_COLUMN_ORDER; }
}

export function moveProductsAreaColumn(order: ProductsAreaOrderedColumn[], id: ProductsAreaOrderedColumn, to: number): ProductsAreaOrderedColumn[] {
  if (!order.includes(id)) return order;
  const next = order.filter((other) => other !== id);
  next.splice(Math.max(0, Math.min(to, order.length - 1)), 0, id);
  return next;
}

// A dragged row lands after every other row whose centre its moved centre has passed.
export function productsAreaDropIndex(rows: { y: number; height: number }[], from: number, dy: number): number {
  const centre = rows[from].y + rows[from].height / 2 + dy;
  return rows.filter((row, index) => index !== from && row.y + row.height / 2 < centre).length;
}

const listeners = new Set<() => void>();
export function useProductsAreaColumns(storage: SessionStorage | null, baseUrl: string): {
  settings: ProductsAreaColumnSettings; save: (next: ProductsAreaColumnSettings) => void; reset: () => void;
  order: ProductsAreaOrderedColumn[]; saveOrder: (next: ProductsAreaOrderedColumn[]) => void;
} {
  const [settings, setSettings] = useState(() => loadProductsAreaColumns(storage, baseUrl));
  const [order, setOrder] = useState(() => loadProductsAreaColumnOrder(storage, baseUrl));
  useEffect(() => {
    const reload = () => { setSettings(loadProductsAreaColumns(storage, baseUrl)); setOrder(loadProductsAreaColumnOrder(storage, baseUrl)); };
    reload(); listeners.add(reload);
    return () => { listeners.delete(reload); };
  }, [storage, baseUrl]);
  const save = useCallback((next: ProductsAreaColumnSettings) => {
    saveProductsAreaColumns(storage, baseUrl, next); listeners.forEach((listener) => listener());
  }, [storage, baseUrl]);
  const saveOrder = useCallback((next: ProductsAreaOrderedColumn[]) => {
    storage?.setItem(ORDER_PREFIX + baseUrl, JSON.stringify(next)); listeners.forEach((listener) => listener());
  }, [storage, baseUrl]);
  const reset = useCallback(() => { save(DEFAULT_PRODUCTS_AREA_COLUMNS); saveOrder(DEFAULT_PRODUCTS_AREA_COLUMN_ORDER); }, [save, saveOrder]);
  return { settings, save, reset, order, saveOrder };
}
