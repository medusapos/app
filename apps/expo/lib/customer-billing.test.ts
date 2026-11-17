import { describe, expect, it, vi } from 'vitest';
import { ConnectorUnauthorizedError, CustomerServiceError, type SyncContext } from '@tallyui/core';
import { billingAddress, billingChanged, billingCountryValid, billingFields, EMPTY_BILLING, hasBilling, loadCustomerBilling } from './customer-billing';

const stored = { firstName: 'Ada', lastName: 'Lovelace', company: 'Analytical', phone: '123', email: 'ada@example.com',
  address1: '1 Old St', address2: 'Flat 2', city: 'London', state: 'London', postcode: 'N1 1AA', country: 'GB' };

describe('billing fields', () => {
  it('picks the six fields and defaults absent values to empty strings', () => {
    expect(billingFields(undefined)).toEqual(EMPTY_BILLING);
    expect(billingFields(stored)).toEqual({ address1: '1 Old St', address2: 'Flat 2', city: 'London',
      state: 'London', postcode: 'N1 1AA', country: 'GB' });
  });
  it('preserves other address keys, trims, removes blank keys and uppercases country', () => {
    expect(billingAddress({ ...billingFields(stored), address1: ' 2 New St ', address2: ' ', country: ' gb ' }, stored))
      .toEqual({ firstName: 'Ada', lastName: 'Lovelace', company: 'Analytical', phone: '123', email: 'ada@example.com',
        address1: '2 New St', city: 'London', state: 'London', postcode: 'N1 1AA', country: 'GB' });
    expect(stored.address2).toBe('Flat 2');
  });
  it('compares trimmed fields, ignoring country case, and detects a city-only change', () => {
    expect(billingChanged({ ...billingFields(stored), address1: ' 1 Old St ', city: ' London ', country: ' gb ' }, stored)).toBe(false);
    expect(billingChanged({ ...billingFields(stored), city: 'Leeds' }, stored)).toBe(true);
    expect(billingChanged({ ...EMPTY_BILLING, city: 'Leeds' }, undefined)).toBe(true);
    expect(billingChanged(EMPTY_BILLING, undefined)).toBe(false);
  });
  it('trims stored fields when comparing billing changes', () => {
    expect(billingChanged({ ...EMPTY_BILLING, city: 'London' }, { city: 'London ' })).toBe(false);
    expect(billingChanged({ ...EMPTY_BILLING, city: 'London' }, { city: 'Leeds' })).toBe(true);
  });
  it.each([['', true], ['gb', true], ['GBR', false], ['G1', false]] as const)('validates country %s', (country, valid) => {
    expect(billingCountryValid({ ...EMPTY_BILLING, country })).toBe(valid);
  });
  it('ignores whitespace-only billing fields', () => {
    expect(hasBilling({ address1: ' ', address2: '\t', city: ' ', state: ' ', postcode: ' ', country: ' ' })).toBe(false);
    expect(hasBilling({ ...EMPTY_BILLING, city: ' Leeds ' })).toBe(true);
  });
});

describe('loadCustomerBilling', () => {
  const headers = { Authorization: 'Bearer test' };
  const signal = new AbortController().signal;
  const context = (fetch: typeof globalThis.fetch): SyncContext => ({ connectorId: 'medusa', baseUrl: 'https://store.test', headers, signal, fetch });
  it('reads only the default billing address and maps non-empty strings', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ customer: { id: 'cus_1', addresses: [
      { id: 'shipping', address_1: 'Wrong St', is_default_shipping: true },
      { id: 'billing', is_default_billing: true, first_name: 'Ada', last_name: 'Lovelace', company: 'Analytical',
        address_1: '1 Old St', address_2: '', city: 'London', province: 'London', postal_code: 'N1 1AA', country_code: 'gb', phone: null },
    ] } }));
    expect(await loadCustomerBilling(context(fetch), 'cus_1')).toEqual({ firstName: 'Ada', lastName: 'Lovelace', company: 'Analytical',
      address1: '1 Old St', city: 'London', state: 'London', postcode: 'N1 1AA', country: 'GB' });
    expect(fetch).toHaveBeenCalledExactlyOnceWith('https://store.test/admin/customers/cus_1?fields=id,*addresses', { headers, signal });
  });
  it('returns undefined when there is no default billing address and encodes the customer id', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ customer: { addresses: [{ address_1: 'First St' }] } }));
    expect(await loadCustomerBilling(context(fetch), 'cus/1')).toBeUndefined();
    expect(fetch.mock.calls[0][0]).toBe('https://store.test/admin/customers/cus%2F1?fields=id,*addresses');
  });
  it.each([401, 403] as const)('maps HTTP %s to an authorization error', async (status) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('', { status }));
    const promise = loadCustomerBilling(context(fetch), 'cus_1');
    await expect(promise).rejects.toBeInstanceOf(ConnectorUnauthorizedError);
    await expect(promise).rejects.toMatchObject({ status });
  });
  it('maps a rejected fetch to a network error', async () => {
    const promise = loadCustomerBilling(context(vi.fn().mockRejectedValue(new Error('offline'))), 'cus_1');
    await expect(promise).rejects.toBeInstanceOf(CustomerServiceError);
    await expect(promise).rejects.toMatchObject({ code: 'network', message: 'offline' });
  });
  it.each([[500, { customer: {} }, 'HTTP 500'], [200, {}, 'unexpected response']] as const)(
    'maps an invalid response (%s) to a server error', async (status, body, message) => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(body, { status }));
      await expect(loadCustomerBilling(context(fetch), 'cus_1')).rejects.toMatchObject({ code: 'server', status, message });
    });
});
