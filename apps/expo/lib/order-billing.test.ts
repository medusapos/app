import { describe, expect, it, vi } from 'vitest';
import { ConnectorUnauthorizedError, CustomerServiceError, type SyncContext } from '@tallyui/core';
import { formatOrderAddress, loadOrderBilling } from './order-billing';

describe('formatOrderAddress', () => {
  it('joins street, city, state, postcode and the upper-case country, without name, company or phone', () => {
    expect(formatOrderAddress({ firstName: 'Ada', lastName: 'Lovelace', company: 'Engines', phone: '+45 1234', address1: 'Nørregade 1',
      address2: '2nd floor', city: 'Copenhagen', state: 'Capital', postcode: '1165', country: 'DK' }))
      .toBe('Nørregade 1, 2nd floor, Copenhagen, Capital, 1165, DK');
  });
  it('leaves out missing and blank parts, trims each, and upper-cases a lower-case country', () => {
    expect(formatOrderAddress({ address1: '  Main St 5 ', address2: '   ', city: 'Berlin', country: ' de ' })).toBe('Main St 5, Berlin, DE');
    expect(formatOrderAddress({ country: 'us' })).toBe('US');
  });
  it('is null when nothing is left', () => {
    expect(formatOrderAddress({ firstName: 'Ada', phone: '1', address1: ' ', city: '' })).toBeNull();
    expect(formatOrderAddress({})).toBeNull();
    expect(formatOrderAddress(undefined)).toBeNull();
    expect(formatOrderAddress(null)).toBeNull();
  });
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function contextWith(answer: Response | Error) {
  const fetch = vi.fn<typeof globalThis.fetch>(() => answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer));
  const signal = new AbortController().signal;
  const context: SyncContext = { connectorId: 'medusa', baseUrl: 'https://store.test', headers: { Authorization: 'Bearer t' }, fetch, signal };
  return { fetch, context, signal };
}

describe('loadOrderBilling', () => {
  it('asks /admin/orders once for the ids, URL-encoded, with only the shown billing fields, and the session headers', async () => {
    const { fetch, context, signal } = contextWith(json({ orders: [] }));
    await loadOrderBilling(context, ['order_1', 'order 2&x']);
    expect(fetch).toHaveBeenCalledExactlyOnceWith('https://store.test/admin/orders?id[]=order_1&id[]=order%202%26x&limit=2'
      + '&fields=id,billing_address.address_1,billing_address.address_2,billing_address.city,billing_address.province,'
      + 'billing_address.postal_code,billing_address.country_code', { headers: { Authorization: 'Bearer t' }, signal });
  });

  it('maps each answered order to its formatted address, an order without one to null, and leaves out the rest', async () => {
    const { context } = contextWith(json({ orders: [
      { id: 'order_1', billing_address: { address_1: 'Nørregade 1', city: 'Copenhagen', postal_code: '1165', country_code: 'dk',
        first_name: 'Ada', phone: '123' } },
      { id: 'order_2', billing_address: null },
      { id: 'order_3' },
      { id: 'order_4', billing_address: { address_1: '', city: '' } },
      { id: 'order_nobody_asked_for', billing_address: { city: 'Elsewhere' } },
    ] }));
    const billing = await loadOrderBilling(context, ['order_1', 'order_2', 'order_3', 'order_4', 'order_missing']);
    expect([...billing]).toEqual([
      ['order_1', 'Nørregade 1, Copenhagen, 1165, DK'], ['order_2', null], ['order_3', null], ['order_4', null],
    ]);
    expect(billing.has('order_missing')).toBe(false);
    expect(billing.has('order_nobody_asked_for')).toBe(false);
  });

  it('sends nothing for no ids', async () => {
    const { fetch, context } = contextWith(json({ orders: [] }));
    expect([...await loadOrderBilling(context, [])]).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([[401, 'unauthorized'], [403, 'forbidden']] as const)('HTTP %s is ConnectorUnauthorizedError %s', async (status, code) => {
    const { context } = contextWith(json({}, status));
    const error = await loadOrderBilling(context, ['order_1']).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConnectorUnauthorizedError);
    expect(error).toMatchObject({ code, status });
  });

  it('a refused fetch is a network CustomerServiceError', async () => {
    const { context } = contextWith(new TypeError('Failed to fetch'));
    const error = await loadOrderBilling(context, ['order_1']).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CustomerServiceError);
    expect(error).toMatchObject({ code: 'network', message: 'Failed to fetch' });
  });

  it('another HTTP failure, or a body without an orders array, is a server CustomerServiceError', async () => {
    for (const answer of [json({}, 500), json({ order: {} }), json({ orders: null })]) {
      const { context } = contextWith(answer);
      const error = await loadOrderBilling(context, ['order_1']).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(CustomerServiceError);
      expect(error).toMatchObject({ code: 'server' });
    }
  });
});
