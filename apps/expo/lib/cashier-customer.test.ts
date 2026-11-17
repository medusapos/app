// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  findCashierCustomer, forgetDeletedCashierCustomer, loadCashierCustomer, loadDefaultCustomerIsCashier,
  saveDefaultCustomerIsCashier, useCashierCustomer,
} from './cashier-customer';

const baseUrl = 'https://store.test', email = 'Admin@Store.test';
const switchKey = 'medusapos.default-customer-is-cashier.' + baseUrl;
const cacheKey = 'medusapos.cashier-customer.' + baseUrl + '.admin@store.test';
const admin = { id: 'cus_admin', name: 'Store Admin', email: 'admin@store.test' };
const fuzzy = { id: 'cus_x', name: 'X Admin', email: 'xadmin@store.test' };
function fakeStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  };
}
const session = { baseUrl, email };
afterEach(cleanup);

describe('cashier-customer', () => {
  it('is off by default, saves per store, and turning it off removes the key', () => {
    const storage = fakeStorage();
    expect(loadDefaultCustomerIsCashier(storage, baseUrl)).toBe(false);
    expect(loadDefaultCustomerIsCashier(null, baseUrl)).toBe(false);
    saveDefaultCustomerIsCashier(storage, baseUrl, true);
    expect(loadDefaultCustomerIsCashier(storage, baseUrl)).toBe(true);
    expect(loadDefaultCustomerIsCashier(storage, 'https://other.test')).toBe(false);
    saveDefaultCustomerIsCashier(storage, baseUrl, false);
    expect(storage.store.has(switchKey)).toBe(false);
    expect(loadDefaultCustomerIsCashier(storage, baseUrl)).toBe(false);
  });

  it('finds the exact email match case-insensitively, skipping a fuzzy hit listed first', async () => {
    const search = vi.fn().mockResolvedValue([fuzzy, { ...admin, email: 'ADMIN@store.test' }]);
    expect(await findCashierCustomer(search, ' admin@Store.test ')).toEqual({ ...admin, email: 'ADMIN@store.test' });
    expect(search).toHaveBeenCalledWith('admin@Store.test');
  });

  it('finds nothing when no result has that email', async () => {
    expect(await findCashierCustomer(vi.fn().mockResolvedValue([fuzzy, { id: 'cus_n', name: 'No email' }]), email)).toBeNull();
  });

  it('resolves through the search, caches the customer, and every hook sees the switch turned off', async () => {
    const storage = fakeStorage({ [switchKey]: 'true' });
    const search = vi.fn().mockResolvedValue([fuzzy, admin]);
    const first = renderHook(() => useCashierCustomer(storage, session, search));
    expect(first.result.current.status).toBe('resolving');
    await waitFor(() => expect(first.result.current.status).toBe('found'));
    expect(first.result.current.customer).toEqual(admin);
    expect(loadCashierCustomer(storage, baseUrl, email)).toEqual(admin);
    const second = renderHook(() => useCashierCustomer(storage, session, search));
    await waitFor(() => expect(second.result.current.status).toBe('found'));
    first.rerender();
    expect(search).toHaveBeenCalledTimes(2);
    act(() => second.result.current.setOn(false));
    expect(first.result.current).toMatchObject({ on: false, customer: null, status: 'off' });
    expect(storage.store.has(switchKey)).toBe(false);
  });

  it('clears a stale cached customer when the search finds no match', async () => {
    const storage = fakeStorage({ [switchKey]: 'true', [cacheKey]: JSON.stringify(admin) });
    const { result } = renderHook(() => useCashierCustomer(storage, session, vi.fn().mockResolvedValue([fuzzy])));
    expect(result.current).toMatchObject({ status: 'resolving', customer: admin });
    await waitFor(() => expect(result.current.status).toBe('none'));
    expect(result.current.customer).toBeNull();
    expect(storage.store.has(cacheKey)).toBe(false);
  });

  it('keeps the cached customer when the search fails, and reports the error', async () => {
    const storage = fakeStorage({ [switchKey]: 'true', [cacheKey]: JSON.stringify(admin) });
    const failure = new Error('offline'), onError = vi.fn();
    const { result } = renderHook(() => useCashierCustomer(storage, session, vi.fn().mockRejectedValue(failure), onError));
    await waitFor(() => expect(result.current.status).toBe('offline'));
    expect(result.current.customer).toEqual(admin);
    expect(onError).toHaveBeenCalledWith(failure);
    expect(storage.getItem(cacheKey)).toBe(JSON.stringify(admin));
  });

  it('forgets the cached customer only for a customer_ignored warning naming it', () => {
    const storage = fakeStorage({ [cacheKey]: JSON.stringify(admin) });
    expect(forgetDeletedCashierCustomer(storage, baseUrl, email, [
      { code: 'customer_ignored', customerId: 'cus_other' },
      { code: 'insufficient_stock', variantId: 'blue', quantity: 2 },
    ])).toBe(false);
    expect(forgetDeletedCashierCustomer(storage, baseUrl, email, undefined)).toBe(false);
    expect(storage.store.has(cacheKey)).toBe(true);
    expect(forgetDeletedCashierCustomer(storage, baseUrl, email, [{ code: 'customer_ignored', customerId: 'cus_admin' }])).toBe(true);
    expect(storage.store.has(cacheKey)).toBe(false);
  });
});
