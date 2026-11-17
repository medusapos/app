// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { loadDefaultCustomer, saveDefaultCustomer, useDefaultCustomer } from './default-customer';

const baseUrl = 'https://store.test', key = 'medusapos.default-customer.' + baseUrl;
const ada = { id: 'ada', name: 'Ada Lovelace', email: 'ada@example.com' };
function fakeStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  };
}
afterEach(cleanup);

describe('default-customer', () => {
  it('round-trips only id, name and email, dropping extra fields on save and load', () => {
    const storage = fakeStorage(), customer = { ...ada, billing: { address1: '1 Private Lane', city: 'Dublin' } };
    saveDefaultCustomer(storage, baseUrl, customer);
    expect(JSON.parse(storage.store.get(key)!)).toEqual(ada);
    expect(loadDefaultCustomer(storage, baseUrl)).toEqual(ada);
    storage.setItem(key, JSON.stringify(customer));
    expect(loadDefaultCustomer(storage, baseUrl)).toEqual(ada);
  });

  it('returns null when nothing is stored or storage is unavailable', () => {
    expect(loadDefaultCustomer(fakeStorage(), baseUrl)).toBeNull();
    expect(loadDefaultCustomer(null, baseUrl)).toBeNull();
    expect(loadDefaultCustomer({ ...fakeStorage(), getItem: () => { throw new Error('denied'); } }, baseUrl)).toBeNull();
  });

  it.each(['{', 'null', '[]', '"ada"', '{"name":"x"}', '{"id":"","name":"x"}',
    '{"id":"ada","name":1}', '{"id":"ada","name":"Ada","email":null}'])('rejects corrupt or invalid storage: %s', (value) => {
    expect(loadDefaultCustomer(fakeStorage({ [key]: value }), baseUrl)).toBeNull();
  });

  it('removes the key when saved as null', () => {
    const storage = fakeStorage({ [key]: JSON.stringify(ada) });
    saveDefaultCustomer(storage, baseUrl, null);
    expect(storage.store.has(key)).toBe(false);
    expect(loadDefaultCustomer(storage, baseUrl)).toBeNull();
  });

  it('updates every mounted reader on save and keeps identity between saves', () => {
    const storage = fakeStorage({ [key]: JSON.stringify(ada) });
    const first = renderHook(() => useDefaultCustomer(storage, baseUrl));
    const second = renderHook(() => useDefaultCustomer(storage, baseUrl));
    const customer = first.result.current.customer;
    first.rerender();
    expect(first.result.current.customer).toBe(customer);
    act(() => second.result.current.save(null));
    expect(first.result.current.customer).toBeNull();
    act(() => second.result.current.save({ id: 'ada', name: 'Ada Lovelace' }));
    expect(first.result.current.customer).toEqual({ id: 'ada', name: 'Ada Lovelace' });
    expect(second.result.current.customer).toEqual(first.result.current.customer);
  });
});
