// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
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
    saveProductSettings(storage, 'https://a.test', { variations: 'popover' });
    expect(storage.getItem('medusapos.product-settings.https://a.test')).toBe('{"variations":"popover"}');
    expect(loadProductSettings(storage, 'https://a.test')).toEqual({ variations: 'popover' });
    expect(loadProductSettings(storage, 'https://b.test')).toEqual(DEFAULT_PRODUCT_SETTINGS);
  });

  it.each([null, 'not json', '{}', 'null', '[]', '"popover"', '{"variations":"unknown"}'])('defaults on missing, corrupt or unknown data: %s', (raw) => {
    const storage = fakeStorage();
    if (raw !== null) storage.setItem('medusapos.product-settings.https://a.test', raw);
    expect(loadProductSettings(storage, 'https://a.test')).toEqual(DEFAULT_PRODUCT_SETTINGS);
    expect(loadProductSettings(null, 'https://a.test')).toEqual(DEFAULT_PRODUCT_SETTINGS);
  });

  it('saves and resets every mounted reader', () => {
    const storage = fakeStorage();
    const first = renderHook(() => useProductSettings(storage, 'https://a.test'));
    const second = renderHook(() => useProductSettings(storage, 'https://a.test'));
    act(() => first.result.current.save({ variations: 'popover' }));
    expect(second.result.current.settings).toEqual({ variations: 'popover' });
    act(() => second.result.current.reset());
    expect(first.result.current.settings).toEqual(DEFAULT_PRODUCT_SETTINGS);
    expect(second.result.current.settings).toEqual(DEFAULT_PRODUCT_SETTINGS);
    expect(loadProductSettings(storage, 'https://a.test')).toEqual(DEFAULT_PRODUCT_SETTINGS);
  });
});
