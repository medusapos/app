import { describe, expect, it } from 'vitest';
import { DEFAULT_CUSTOMER_COLUMNS, loadCustomerColumns, saveCustomerColumns } from './customer-columns';

function fakeStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  };
}

const KEY = 'medusapos.customer-columns.https://a.test';

describe('customer-columns', () => {
  it('round-trips a saved value', () => {
    const storage = fakeStorage();
    const settings = { avatar: false, firstName: true, lastName: false, email: true };
    saveCustomerColumns(storage, 'https://a.test', settings);
    expect(loadCustomerColumns(storage, 'https://a.test')).toEqual(settings);
  });

  it('returns the defaults when nothing is stored', () => {
    expect(loadCustomerColumns(fakeStorage(), 'https://a.test')).toEqual(DEFAULT_CUSTOMER_COLUMNS);
    expect(loadCustomerColumns(null, 'https://a.test')).toEqual(DEFAULT_CUSTOMER_COLUMNS);
  });

  it('returns the defaults on corrupt JSON', () => {
    expect(loadCustomerColumns(fakeStorage({ [KEY]: '{not json' }), 'https://a.test')).toEqual(DEFAULT_CUSTOMER_COLUMNS);
  });

  it.each([
    ['a non-boolean value', { email: 'no' }],
    ['an unknown column', { phone: true }],
    ['an array', []],
    ['every column off', { avatar: false, firstName: false, lastName: false, email: false }],
  ])('returns the defaults on %s', (_, value) => {
    expect(loadCustomerColumns(fakeStorage({ [KEY]: JSON.stringify(value) }), 'https://a.test')).toEqual(DEFAULT_CUSTOMER_COLUMNS);
  });

  it('keeps the other defaults for a partial stored value', () => {
    expect(loadCustomerColumns(fakeStorage({ [KEY]: JSON.stringify({ email: false }) }), 'https://a.test'))
      .toEqual({ ...DEFAULT_CUSTOMER_COLUMNS, email: false });
  });

  it('keeps each store its own choice', () => {
    const storage = fakeStorage();
    saveCustomerColumns(storage, 'https://a.test', { ...DEFAULT_CUSTOMER_COLUMNS, avatar: false });
    expect(loadCustomerColumns(storage, 'https://b.test')).toEqual(DEFAULT_CUSTOMER_COLUMNS);
    expect(loadCustomerColumns(storage, 'https://a.test')).toEqual({ ...DEFAULT_CUSTOMER_COLUMNS, avatar: false });
  });

  it('refuses to save with every column off', () => {
    const storage = fakeStorage();
    expect(() => saveCustomerColumns(storage, 'https://a.test', { avatar: false, firstName: false, lastName: false, email: false }))
      .toThrow('At least one column must show.');
    expect(storage.getItem(KEY)).toBeNull();
  });
});
