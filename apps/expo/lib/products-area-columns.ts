import { useCallback, useEffect, useState } from 'react';
import type { SessionStorage } from './session';

// The Products table's optional columns; the Product (name) column always shows.
export type ProductsAreaColumn = 'sku' | 'stock' | 'stockStatus' | 'category' | 'price';
export const PRODUCTS_AREA_COLUMNS: { id: ProductsAreaColumn; label: string }[] = [
  { id: 'sku', label: 'SKU' }, { id: 'stock', label: 'Stock' }, { id: 'stockStatus', label: 'Stock status' },
  { id: 'category', label: 'Category' }, { id: 'price', label: 'Price' },
];
export type ProductsAreaColumnSettings = Record<ProductsAreaColumn, boolean>;
// v2's Products table shows every one of these columns by default.
export const DEFAULT_PRODUCTS_AREA_COLUMNS: ProductsAreaColumnSettings = {
  sku: true, stock: true, stockStatus: true, category: true, price: true,
};
const PREFIX = 'medusapos.products-area-columns.';

export function loadProductsAreaColumns(storage: SessionStorage | null, baseUrl: string): ProductsAreaColumnSettings {
  try {
    const value: unknown = JSON.parse(storage?.getItem(PREFIX + baseUrl) ?? 'null');
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return DEFAULT_PRODUCTS_AREA_COLUMNS;
    const valid = Object.entries(value).every(([id, on]) =>
      PRODUCTS_AREA_COLUMNS.some((column) => column.id === id) && typeof on === 'boolean');
    return valid ? { ...DEFAULT_PRODUCTS_AREA_COLUMNS, ...(value as Partial<ProductsAreaColumnSettings>) } : DEFAULT_PRODUCTS_AREA_COLUMNS;
  } catch { return DEFAULT_PRODUCTS_AREA_COLUMNS; }
}

// Every switch may be off: the Product column still shows.
export function saveProductsAreaColumns(storage: SessionStorage | null, baseUrl: string, settings: ProductsAreaColumnSettings): void {
  storage?.setItem(PREFIX + baseUrl, JSON.stringify(settings));
}

const listeners = new Set<() => void>();
export function useProductsAreaColumns(storage: SessionStorage | null, baseUrl: string): {
  settings: ProductsAreaColumnSettings; save: (next: ProductsAreaColumnSettings) => void; reset: () => void;
} {
  const [settings, setSettings] = useState(() => loadProductsAreaColumns(storage, baseUrl));
  useEffect(() => {
    const reload = () => setSettings(loadProductsAreaColumns(storage, baseUrl));
    reload(); listeners.add(reload);
    return () => { listeners.delete(reload); };
  }, [storage, baseUrl]);
  const save = useCallback((next: ProductsAreaColumnSettings) => {
    saveProductsAreaColumns(storage, baseUrl, next); listeners.forEach((listener) => listener());
  }, [storage, baseUrl]);
  return { settings, save, reset: useCallback(() => save(DEFAULT_PRODUCTS_AREA_COLUMNS), [save]) };
}
