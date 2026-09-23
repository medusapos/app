import { describe, expect, it } from 'vitest';
import type { SessionStorage } from './session';
import { getRegisterId } from './register';

function memoryStorage(): SessionStorage {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); },
    removeItem: (key) => { data.delete(key); },
  };
}
const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('getRegisterId', () => {
  it('persists a UUIDv7 and returns it on subsequent calls', () => {
    const storage = memoryStorage();
    const id = getRegisterId(storage);
    expect(id).toMatch(uuidV7);
    expect(storage.getItem('medusapos.register_id')).toBe(id);
    expect(getRegisterId(storage)).toBe(id);
  });
  it('reads a previously stored id', () => {
    const storage = memoryStorage();
    const id = '0195aa30-5c00-7000-8000-000000000001';
    storage.setItem('medusapos.register_id', id);
    expect(getRegisterId(storage)).toBe(id);
  });
  it('creates different ids for different browser storages', () => {
    expect(getRegisterId(memoryStorage())).not.toBe(getRegisterId(memoryStorage()));
  });
  it('uses a stable process id with null, throwing reads or throwing writes', () => {
    const fail = () => { throw new Error('Storage unavailable'); };
    const id = getRegisterId(null);
    expect(id).toMatch(uuidV7);
    expect(getRegisterId(null)).toBe(id);
    expect(getRegisterId({ getItem: fail, setItem: fail, removeItem: fail })).toBe(id);
    expect(getRegisterId({ getItem: () => null, setItem: fail, removeItem: fail })).toBe(id);
  });
});
