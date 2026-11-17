import { useCallback, useEffect, useState } from 'react';
import type { CartColumnSettings } from '@tallyui/components';
import type { SessionStorage } from './session';

export type CartSettings = {
  cartSide: 'left' | 'right'; openOrders: 'top' | 'bottom'; quickDiscounts: number[]; columns: CartColumnSettings;
};

// WCPOS 2 Cart Settings defaults (cart right, open orders at the bottom, quick discounts 5/10/15).
export const DEFAULT_CART_SETTINGS: CartSettings = {
  cartSide: 'right', openOrders: 'bottom', quickDiscounts: [5, 10, 15],
  // v2's and TallyUI's column defaults: Qty, Name, Price and Total show; Image, SKU, Split and Name › SKU are off.
  columns: { quantity: { show: true, split: false }, image: { show: false }, name: { show: true, sku: false },
    sku: { show: false }, price: { show: true }, total: { show: true } },
};

const PREFIX = 'medusapos.cart.';
const isValidBase = (v: unknown): v is Omit<CartSettings, 'columns'> => {
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

export function loadCartSettings(storage: SessionStorage | null, baseUrl: string): CartSettings {
  try {
    const value: unknown = JSON.parse(storage?.getItem(PREFIX + baseUrl) ?? 'null');
    if (!isValidBase(value)) return DEFAULT_CART_SETTINGS;
    // Settings saved before the Columns section have no `columns`; they keep their other choices.
    const { columns } = value as Partial<CartSettings>;
    return { ...value, columns: isValidColumns(columns) ? columns : DEFAULT_CART_SETTINGS.columns };
  } catch { return DEFAULT_CART_SETTINGS; }
}

export function saveCartSettings(storage: SessionStorage | null, baseUrl: string, settings: CartSettings): void {
  if (!isValidBase(settings)) throw new Error('Quick discounts must be three whole numbers from 1 to 100.');
  if (!isValidColumns(settings.columns)) throw new Error('Cart columns are not valid.');
  storage?.setItem(PREFIX + baseUrl, JSON.stringify(settings));
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
