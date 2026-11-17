import { useCallback, useEffect, useState } from 'react';
import type { SessionStorage } from './session';

export type CartSettings = { cartSide: 'left' | 'right'; openOrders: 'top' | 'bottom'; quickDiscounts: number[] };

// WCPOS 2 Cart Settings defaults (cart right, open orders at the bottom, quick discounts 5/10/15).
export const DEFAULT_CART_SETTINGS: CartSettings = { cartSide: 'right', openOrders: 'bottom', quickDiscounts: [5, 10, 15] };

const PREFIX = 'medusapos.cart.';
const isValidSettings = (v: unknown): v is CartSettings => {
  if (typeof v !== 'object' || v === null) return false;
  const { cartSide, openOrders, quickDiscounts } = v as CartSettings;
  return (cartSide === 'left' || cartSide === 'right') && (openOrders === 'top' || openOrders === 'bottom')
    && Array.isArray(quickDiscounts) && quickDiscounts.length === 3
    && quickDiscounts.every((value) => Number.isInteger(value) && value >= 1 && value <= 100);
};

export function loadCartSettings(storage: SessionStorage | null, baseUrl: string): CartSettings {
  try {
    const value: unknown = JSON.parse(storage?.getItem(PREFIX + baseUrl) ?? 'null');
    return isValidSettings(value) ? value : DEFAULT_CART_SETTINGS;
  } catch { return DEFAULT_CART_SETTINGS; }
}

export function saveCartSettings(storage: SessionStorage | null, baseUrl: string, settings: CartSettings): void {
  if (!isValidSettings(settings)) throw new Error('Quick discounts must be three whole numbers from 1 to 100.');
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
