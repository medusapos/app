import { useCallback, useEffect, useState } from 'react';
import type { CartColumnSettings } from '@tallyui/components';
import type { SessionStorage } from './session';

export type CartSortItems = 'newest-bottom' | 'newest-top' | 'name' | 'price';
export type CartSettings = {
  cartSide: 'left' | 'right'; openOrders: 'top' | 'bottom'; quickDiscounts: number[]; columns: CartColumnSettings;
  autoShowReceipt: boolean; sortItems: CartSortItems;
};

// WCPOS 2 Cart Settings defaults (cart right, open orders at the bottom, quick discounts 5/10/15).
export const DEFAULT_CART_SETTINGS: CartSettings = {
  cartSide: 'right', openOrders: 'bottom', quickDiscounts: [5, 10, 15],
  // v2's and TallyUI's column defaults: Qty, Name, Price and Total show; Image, SKU, Split and Name › SKU are off.
  columns: { quantity: { show: true, split: false }, image: { show: false }, name: { show: true, sku: false },
    sku: { show: false }, price: { show: true }, total: { show: true } },
  // v2's "Automatically show receipt after checkout": on by default.
  autoShowReceipt: true,
  // v2's "Sort items" choices; ours defaults to the order added, today's cart.
  sortItems: 'newest-bottom',
};

const PREFIX = 'medusapos.cart.';
const isValidBase = (v: unknown): v is Omit<CartSettings, 'columns' | 'autoShowReceipt' | 'sortItems'> => {
  if (typeof v !== 'object' || v === null) return false;
  const { cartSide, openOrders, quickDiscounts } = v as CartSettings;
  return (cartSide === 'left' || cartSide === 'right') && (openOrders === 'top' || openOrders === 'bottom')
    && Array.isArray(quickDiscounts) && quickDiscounts.length === 3
    && quickDiscounts.every((value) => Number.isInteger(value) && value >= 1 && value <= 100);
};

// Each column's allowed flags; a missing column or flag is left for TallyUI to default.
const COLUMN_FLAGS: Record<string, string[]> = {
  quantity: ['show', 'split'], image: ['show'], name: ['show', 'sku'], sku: ['show'], price: ['show'], total: ['show'],
};
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isValidColumns = (v: unknown): v is CartColumnSettings => isRecord(v) && Object.entries(v).every(([id, flags]) =>
  Object.hasOwn(COLUMN_FLAGS, id) && isRecord(flags)
  && Object.entries(flags).every(([flag, on]) => COLUMN_FLAGS[id].includes(flag) && typeof on === 'boolean'));
const SORT_ITEMS: readonly unknown[] = ['newest-bottom', 'newest-top', 'name', 'price'] satisfies CartSortItems[];
const isValidSortItems = (v: unknown): v is CartSortItems => SORT_ITEMS.includes(v);

export function loadCartSettings(storage: SessionStorage | null, baseUrl: string): CartSettings {
  try {
    const value: unknown = JSON.parse(storage?.getItem(PREFIX + baseUrl) ?? 'null');
    if (!isValidBase(value)) return DEFAULT_CART_SETTINGS;
    // Settings saved before the Columns section (or the auto-show switch, or Sort items) lack that field; they keep their other choices.
    const { columns, autoShowReceipt, sortItems } = value as Partial<CartSettings>;
    return { ...value, columns: isValidColumns(columns) ? columns : DEFAULT_CART_SETTINGS.columns,
      autoShowReceipt: typeof autoShowReceipt === 'boolean' ? autoShowReceipt : DEFAULT_CART_SETTINGS.autoShowReceipt,
      sortItems: isValidSortItems(sortItems) ? sortItems : DEFAULT_CART_SETTINGS.sortItems };
  } catch { return DEFAULT_CART_SETTINGS; }
}

export function saveCartSettings(storage: SessionStorage | null, baseUrl: string, settings: CartSettings): void {
  if (!isValidBase(settings)) throw new Error('Quick discounts must be three whole numbers from 1 to 100.');
  if (!isValidColumns(settings.columns)) throw new Error('Cart columns are not valid.');
  if (typeof settings.autoShowReceipt !== 'boolean') throw new Error('Auto show receipt must be on or off.');
  if (!isValidSortItems(settings.sortItems)) throw new Error('Sort items is not valid.');
  storage?.setItem(PREFIX + baseUrl, JSON.stringify(settings));
}

// The cart's display order (v2's Sort items); a copy, never the sale's stored order. Array sort is stable, so ties keep
// the order added. Newest at bottom is the order added itself, so it hands back the same array.
export function sortCartLines<T extends { name: string; unitPriceMinor: number }>(lines: readonly T[], order: CartSortItems): readonly T[] {
  if (order === 'newest-top') return [...lines].reverse();
  if (order === 'name') return [...lines].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  if (order === 'price') return [...lines].sort((a, b) => a.unitPriceMinor - b.unitPriceMinor);
  return lines;
}

const listeners = new Set<() => void>();
export function useCartSettings(storage: SessionStorage | null, baseUrl: string): {
  settings: CartSettings; save: (next: CartSettings) => void; reset: () => void;
} {
  const [settings, setSettings] = useState(() => loadCartSettings(storage, baseUrl));
  useEffect(() => {
    const reload = () => setSettings(loadCartSettings(storage, baseUrl));
    reload(); listeners.add(reload);
    return () => { listeners.delete(reload); };
  }, [storage, baseUrl]);
  const save = useCallback((next: CartSettings) => {
    saveCartSettings(storage, baseUrl, next); listeners.forEach((listener) => listener());
  }, [storage, baseUrl]);
  return { settings, save, reset: useCallback(() => save(DEFAULT_CART_SETTINGS), [save]) };
}
