import { describe, expect, it } from 'vitest';
import { loadTillName, saveTillName } from './till-name';

function fakeStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  };
}

describe('till-name', () => {
  it('round-trips a saved name, trimmed', () => {
    const storage = fakeStorage();
    saveTillName(storage, 'https://a.test', '  Front counter ');
    expect(storage.store.get('medusapos.till-name.https://a.test')).toBe('Front counter');
    expect(loadTillName(storage, 'https://a.test')).toBe('Front counter');
  });

  it('gives null when nothing is stored, the storage is null, or the storage throws', () => {
    expect(loadTillName(fakeStorage(), 'https://a.test')).toBeNull();
    expect(loadTillName(null, 'https://a.test')).toBeNull();
    const throwing = { ...fakeStorage(), getItem: () => { throw new Error('denied'); } };
    expect(loadTillName(throwing, 'https://a.test')).toBeNull();
  });

  it('an empty save removes the key, back to the platform label', () => {
    const storage = fakeStorage({ 'medusapos.till-name.https://a.test': 'Front counter' });
    saveTillName(storage, 'https://a.test', '   ');
    expect(storage.store.has('medusapos.till-name.https://a.test')).toBe(false);
    expect(loadTillName(storage, 'https://a.test')).toBeNull();
  });

  it('a 65-character name throws and leaves the stored name', () => {
    const storage = fakeStorage({ 'medusapos.till-name.https://a.test': 'Front counter' });
    expect(() => saveTillName(storage, 'https://a.test', 'x'.repeat(65))).toThrow('A till name can be at most 64 characters.');
    expect(loadTillName(storage, 'https://a.test')).toBe('Front counter');
    saveTillName(storage, 'https://a.test', 'x'.repeat(64));
    expect(loadTillName(storage, 'https://a.test')).toBe('x'.repeat(64));
  });

  it('keeps one name per baseUrl', () => {
    const storage = fakeStorage();
    saveTillName(storage, 'https://a.test', 'Front counter');
    saveTillName(storage, 'https://b.test', 'Back office');
    expect(loadTillName(storage, 'https://a.test')).toBe('Front counter');
    expect(loadTillName(storage, 'https://b.test')).toBe('Back office');
  });

  it('a stored value over 64 characters loads as null', () => {
    const storage = fakeStorage({ 'medusapos.till-name.https://a.test': 'x'.repeat(65) });
    expect(loadTillName(storage, 'https://a.test')).toBeNull();
  });
});
