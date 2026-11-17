import { useCallback, useEffect, useState } from 'react';
import type { SessionStorage } from './session';

export type ProductSettings = { variations: 'list' | 'popover' };
export const DEFAULT_PRODUCT_SETTINGS: ProductSettings = { variations: 'list' };
const PREFIX = 'medusapos.product-settings.';

export function loadProductSettings(storage: SessionStorage | null, baseUrl: string): ProductSettings {
  try {
    const value = JSON.parse(storage?.getItem(PREFIX + baseUrl) ?? 'null');
    return value?.variations === 'list' || value?.variations === 'popover'
      ? { variations: value.variations } : DEFAULT_PRODUCT_SETTINGS;
  } catch { return DEFAULT_PRODUCT_SETTINGS; }
}

export function saveProductSettings(storage: SessionStorage | null, baseUrl: string, settings: ProductSettings): void {
  storage?.setItem(PREFIX + baseUrl, JSON.stringify(settings));
}

const listeners = new Set<() => void>();
export function useProductSettings(storage: SessionStorage | null, baseUrl: string): {
  settings: ProductSettings; save: (next: ProductSettings) => void; reset: () => void;
} {
  const [settings, setSettings] = useState(() => loadProductSettings(storage, baseUrl));
  useEffect(() => {
    const reload = () => setSettings(loadProductSettings(storage, baseUrl));
    reload(); listeners.add(reload);
    return () => { listeners.delete(reload); };
  }, [storage, baseUrl]);
  const save = useCallback((next: ProductSettings) => {
    saveProductSettings(storage, baseUrl, next); listeners.forEach((listener) => listener());
  }, [storage, baseUrl]);
  return { settings, save, reset: useCallback(() => save(DEFAULT_PRODUCT_SETTINGS), [save]) };
}
