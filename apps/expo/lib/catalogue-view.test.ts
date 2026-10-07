import { describe, expect, it } from 'vitest';
import { loadCatalogueView, saveCatalogueView } from './catalogue-view';

function fakeStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  };
}

describe('catalogue-view', () => {
  it('round-trips a saved value', () => {
    const storage = fakeStorage();
    const state = { view: 'table', categoryId: null, sort: null, gridColumns: 'auto' };
    saveCatalogueView(storage, 'https://a.test', state);
    expect(loadCatalogueView(storage, 'https://a.test')).toEqual(state);
  });

  it('returns nothing when nothing is stored', () => {
    expect(loadCatalogueView(fakeStorage(), 'https://a.test')).toBeUndefined();
    expect(loadCatalogueView(null, 'https://a.test')).toBeUndefined();
  });

  it('returns nothing on a corrupt value', () => {
    const storage = fakeStorage({ 'medusapos.catalogue.https://a.test': '{"view": "tab' });
    expect(loadCatalogueView(storage, 'https://a.test')).toBeUndefined();
  });

  it('returns nothing on a stored value that is not an object', () => {
    for (const value of ['"table"', '42', '["table"]']) {
      expect(loadCatalogueView(fakeStorage({ 'medusapos.catalogue.https://a.test': value }), 'https://a.test')).toBeUndefined();
    }
  });

  it('keeps the keys separate per baseUrl', () => {
    const storage = fakeStorage();
    saveCatalogueView(storage, 'https://a.test', { view: 'table' });
    saveCatalogueView(storage, 'https://b.test', { view: 'grid' });
    expect(loadCatalogueView(storage, 'https://a.test')).toEqual({ view: 'table' });
    expect(loadCatalogueView(storage, 'https://b.test')).toEqual({ view: 'grid' });
  });
});
