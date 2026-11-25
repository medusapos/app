import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_TILE_FIELDS, normalizeTileFields, type TileFields } from '@tallyui/pos';
import type { SessionStorage } from './session';

// browse: v2's "Browse by". 'tiles' opens the Sale on category tiles; 'chips' (product tiles under the category
// chips) stays the default so a till keeps today's start until someone picks Categories.
export type ProductSettings = { variations: 'list' | 'popover'; tileFields: TileFields; browse: 'chips' | 'tiles' };
export const DEFAULT_PRODUCT_SETTINGS: ProductSettings = { variations: 'list', tileFields: DEFAULT_TILE_FIELDS, browse: 'chips' };
const PREFIX = 'medusapos.product-settings.';

export function loadProductSettings(storage: SessionStorage | null, baseUrl: string): ProductSettings {
  try {
    const value = JSON.parse(storage?.getItem(PREFIX + baseUrl) ?? 'null');
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return DEFAULT_PRODUCT_SETTINGS;
    // Each field on its own: a value saved before Tile Fields ({"variations":"popover"}) keeps its variations.
    return {
      variations: value.variations === 'popover' ? 'popover' : 'list',
      tileFields: normalizeTileFields(value.tileFields) ?? DEFAULT_TILE_FIELDS,
      browse: value.browse === 'tiles' ? 'tiles' : 'chips',
    };
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
