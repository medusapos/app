// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_TILE_FIELDS } from '@tallyui/pos';
import { DEFAULT_PRODUCT_SETTINGS, loadProductSettings, saveProductSettings, useProductSettings } from './product-settings';

function fakeStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  };
}
afterEach(cleanup);

describe('product-settings', () => {
  it('round-trips settings under a separate key per store', () => {
    const storage = fakeStorage();
    const tileFields = { ...DEFAULT_TILE_FIELDS, price: false, sku: true };
    saveProductSettings(storage, 'https://a.test', { variations: 'popover', tileFields, browse: 'chips' });
    expect(JSON.parse(storage.getItem('medusapos.product-settings.https://a.test')!)).toEqual({ variations: 'popover', tileFields, browse: 'chips' });
    expect(loadProductSettings(storage, 'https://a.test')).toEqual({ variations: 'popover', tileFields, browse: 'chips' });
    expect(loadProductSettings(storage, 'https://b.test')).toEqual(DEFAULT_PRODUCT_SETTINGS);
  });

  it('loads a value saved before Tile Fields with its variations and the default tile fields', () => {
    const storage = fakeStorage();
    storage.setItem('medusapos.product-settings.https://a.test', '{"variations":"popover"}');
    expect(loadProductSettings(storage, 'https://a.test')).toEqual({ variations: 'popover', tileFields: DEFAULT_TILE_FIELDS, browse: 'chips' });
  });

  it('loads a value saved before Browse by with its variations and tile fields, on product tiles', () => {
    const storage = fakeStorage();
    const tileFields = { ...DEFAULT_TILE_FIELDS, price: false };
    storage.setItem('medusapos.product-settings.https://a.test', JSON.stringify({ variations: 'popover', tileFields }));
    expect(loadProductSettings(storage, 'https://a.test')).toEqual({ variations: 'popover', tileFields, browse: 'chips' });
  });

  it('round-trips Browse by Categories per store', () => {
    const storage = fakeStorage();
    storage.setItem('medusapos.product-settings.https://a.test', '{"browse":"tiles"}');
    const tiles = loadProductSettings(storage, 'https://a.test');
    expect(tiles).toEqual({ ...DEFAULT_PRODUCT_SETTINGS, browse: 'tiles' });
    saveProductSettings(storage, 'https://a.test', tiles);
    expect(loadProductSettings(storage, 'https://a.test').browse).toBe('tiles');
    expect(loadProductSettings(storage, 'https://b.test').browse).toBe('chips');
  });

  it('fills a partial tileFields from the defaults', () => {
    const storage = fakeStorage();
    storage.setItem('medusapos.product-settings.https://a.test', '{"tileFields":{"price":false}}');
    expect(loadProductSettings(storage, 'https://a.test')).toEqual({ variations: 'list', tileFields: { ...DEFAULT_TILE_FIELDS, price: false }, browse: 'chips' });
  });

  it.each([null, 'not json', '{}', 'null', '[]', '"popover"', '{"variations":"unknown"}', '{"tileFields":[]}', '{"tileFields":"x"}', '{"browse":"x"}', '{"browse":true}'])('defaults on missing, corrupt or unknown data: %s', (raw) => {
    const storage = fakeStorage();
    if (raw !== null) storage.setItem('medusapos.product-settings.https://a.test', raw);
    expect(loadProductSettings(storage, 'https://a.test')).toEqual(DEFAULT_PRODUCT_SETTINGS);
    expect(loadProductSettings(null, 'https://a.test')).toEqual(DEFAULT_PRODUCT_SETTINGS);
  });

  it('saves and resets every mounted reader', () => {
    const storage = fakeStorage();
    const first = renderHook(() => useProductSettings(storage, 'https://a.test'));
    const second = renderHook(() => useProductSettings(storage, 'https://a.test'));
    act(() => first.result.current.save({ variations: 'popover', tileFields: DEFAULT_TILE_FIELDS, browse: 'tiles' }));
    expect(second.result.current.settings).toEqual({ variations: 'popover', tileFields: DEFAULT_TILE_FIELDS, browse: 'tiles' });
    act(() => second.result.current.reset());
    expect(first.result.current.settings).toEqual(DEFAULT_PRODUCT_SETTINGS);
    expect(second.result.current.settings).toEqual(DEFAULT_PRODUCT_SETTINGS);
    expect(loadProductSettings(storage, 'https://a.test')).toEqual(DEFAULT_PRODUCT_SETTINGS);
  });
});
