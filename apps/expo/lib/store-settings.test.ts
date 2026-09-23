import { describe, expect, it, vi } from 'vitest';
import type { SessionStorage } from './session';
import {
  clearCachedSettings, fetchStoreSettings, loadCachedSettings, saveCachedSettings,
  StoreSettingsError, taxContextFor, type StoreSettings,
} from './store-settings';

const session = { baseUrl: 'http://localhost:9000', email: 'admin@tally.test', token: 'jwt' };
const settings: StoreSettings = {
  storeName: 'Default Store', currency: 'EUR',
  location: { id: 'loc_1', name: 'European Warehouse', addressLine: 'Street 1, Copenhagen', countryCode: 'dk' },
  taxRatePpm: 250000, pricesIncludeTax: false,
};
function resources(): Record<string, unknown>[] {
  return [
    { stores: [{ name: 'Default Store', default_sales_channel_id: 'sc_1', supported_currencies: [
      { currency_code: 'usd', is_default: false }, { currency_code: 'eur', is_default: true },
    ] }] },
    { sales_channel: { stock_locations: [
      { id: 'loc_1', name: 'European Warehouse', address: { country_code: 'DK', city: 'Copenhagen', address_1: 'Street 1' } },
      { id: 'loc_2', name: 'Other Warehouse', address: { country_code: 'DE' } },
    ] } },
    { tax_regions: [{ country_code: 'dk', province_code: null, parent_id: null, tax_rates: [
      { rate: 10, is_default: false }, { rate: 25, is_default: true },
    ] }] },
    { price_preferences: [{ is_tax_inclusive: false }] },
  ];
}
function fetcher(bodies = resources()) {
  const fetchImpl = vi.fn<() => Promise<Response>>();
  for (const body of bodies) fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify(body)));
  return fetchImpl;
}
function memoryStorage(): SessionStorage {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); },
    removeItem: (key) => { data.delete(key); },
  };
}

describe('fetchStoreSettings', () => {
  it('reads the default currency, first location, country tax and price preference in order', async () => {
    const fetchImpl = fetcher();
    expect(await fetchStoreSettings(session, fetchImpl)).toEqual(settings);
    expect(fetchImpl.mock.calls).toEqual([
      '/admin/stores?fields=id,name,default_sales_channel_id,supported_currencies.currency_code,supported_currencies.is_default',
      '/admin/sales-channels/sc_1?fields=id,name,stock_locations.id,stock_locations.name,stock_locations.address.*',
      '/admin/tax-regions?country_code=dk&fields=id,country_code,province_code,parent_id,tax_rates.rate,tax_rates.is_default',
      '/admin/price-preferences?attribute=currency_code&value=eur&fields=id,is_tax_inclusive',
    ].map((path) => [`${session.baseUrl}${path}`, { headers: { Authorization: 'Bearer jwt' } }]));
  });
  it.each([
    { regions: [] },
    { regions: [{ country_code: 'dk', province_code: null, parent_id: null, tax_rates: [] }] },
    { regions: [{ country_code: 'dk', province_code: null, parent_id: null, tax_rates: [{ rate: 25, is_default: false }] }] },
  ])('uses zero when there is no default country tax: %j', async ({ regions }) => {
    const bodies = resources();
    bodies[2] = { tax_regions: regions };
    expect((await fetchStoreSettings(session, fetcher(bodies))).taxRatePpm).toBe(0);
  });
  it.each([[[], false], [[{ is_tax_inclusive: true }], true]] as const)(
    'reads price preferences %j as %s', async (preferences, inclusive) => {
      const bodies = resources();
      bodies[3] = { price_preferences: preferences };
      expect((await fetchStoreSettings(session, fetcher(bodies))).pricesIncludeTax).toBe(inclusive);
    },
  );
  it('ignores province and child regions in favour of the country-level default', async () => {
    const bodies = resources();
    bodies[2] = { tax_regions: [
      { country_code: 'dk', province_code: 'capital', parent_id: null, tax_rates: [{ rate: 5, is_default: true }] },
      { country_code: 'dk', province_code: null, parent_id: 'parent', tax_rates: [{ rate: 7, is_default: true }] },
      { country_code: 'dk', province_code: null, parent_id: null, tax_rates: [{ rate: '25', is_default: true }] },
    ] };
    expect((await fetchStoreSettings(session, fetcher(bodies))).taxRatePpm).toBe(250000);
  });
  it.each([0, 1, 2, 3])('maps a 401 at resource %s to unauthorized', async (index) => {
    const fetchImpl = fetcher(resources().slice(0, index));
    fetchImpl.mockResolvedValueOnce(new Response(null, { status: 401 }));
    await expect(fetchStoreSettings(session, fetchImpl)).rejects.toMatchObject({ code: 'unauthorized' });
    expect(fetchImpl).toHaveBeenCalledTimes(index + 1);
  });
  it('maps fetch failures and other HTTP errors to unreachable', async () => {
    for (const fetchImpl of [
      vi.fn<() => Promise<Response>>().mockRejectedValue(new TypeError('Failed to fetch')),
      vi.fn<() => Promise<Response>>().mockResolvedValue(new Response(null, { status: 503 })),
    ]) {
      await expect(fetchStoreSettings(session, fetchImpl)).rejects.toBeInstanceOf(StoreSettingsError);
      await expect(fetchStoreSettings(session, fetchImpl)).rejects.toMatchObject({ code: 'unreachable' });
    }
  });
  it.each([
    [0, { stores: [{ name: 'Store', default_sales_channel_id: 'sc_1', supported_currencies: [] }] }, 'default currency'],
    [0, { stores: [{ name: 'Store', supported_currencies: [{ currency_code: 'eur', is_default: true }] }] }, 'default sales channel'],
    [1, { sales_channel: { stock_locations: [] } }, 'stock location'],
  ] as const)('reports missing configuration at resource %s', async (index, body, missing) => {
    const bodies = resources();
    bodies[index] = body;
    await expect(fetchStoreSettings(session, fetcher(bodies))).rejects.toMatchObject({
      code: 'misconfigured', message: expect.stringContaining(missing),
    });
  });
  it.each([
    [{ country_code: 'DK', city: 'Copenhagen' }, 'Copenhagen'],
    [{ country_code: 'DK', address_1: 'Street 1' }, 'Street 1'],
    [{ country_code: 'DK' }, undefined],
  ])('joins only the address parts present: %j', async (address, addressLine) => {
    const bodies = resources();
    bodies[1] = { sales_channel: { stock_locations: [{ id: 'loc_1', name: 'Warehouse', address }] } };
    expect((await fetchStoreSettings(session, fetcher(bodies))).location.addressLine).toBe(addressLine);
  });
});

describe('settings cache', () => {
  it('round-trips and clears independently per backend', () => {
    const storage = memoryStorage();
    const otherUrl = 'https://other.test';
    const other = { ...settings, storeName: 'Other', currency: 'USD' };
    expect(loadCachedSettings(storage, session.baseUrl)).toBeNull();
    saveCachedSettings(storage, session.baseUrl, settings);
    saveCachedSettings(storage, otherUrl, other);
    expect(storage.getItem(`medusapos.settings.${session.baseUrl}`)).toBe(JSON.stringify(settings));
    expect(loadCachedSettings(storage, session.baseUrl)).toEqual(settings);
    expect(loadCachedSettings(storage, otherUrl)).toEqual(other);
    clearCachedSettings(storage, session.baseUrl);
    expect(loadCachedSettings(storage, session.baseUrl)).toBeNull();
    expect(loadCachedSettings(storage, otherUrl)).toEqual(other);
  });
  it.each([
    '{', 'null', '{}', '[]', JSON.stringify({ ...settings, taxRatePpm: '250000' }),
    JSON.stringify({ ...settings, pricesIncludeTax: 'false' }),
    JSON.stringify({ ...settings, location: { id: 'loc_1' } }),
    JSON.stringify({ ...settings, location: { ...settings.location, addressLine: 42 } }),
  ])('rejects malformed cached data %s', (value) => {
    const storage = memoryStorage();
    storage.setItem(`medusapos.settings.${session.baseUrl}`, value);
    expect(loadCachedSettings(storage, session.baseUrl)).toBeNull();
  });
  it('accepts an omitted address line and tolerates unavailable storage', () => {
    const storage = memoryStorage();
    const withoutAddress = { ...settings, location: { id: 'loc_1', name: 'Warehouse', countryCode: 'dk' } };
    saveCachedSettings(storage, session.baseUrl, withoutAddress);
    expect(loadCachedSettings(storage, session.baseUrl)).toEqual(withoutAddress);
    const fail = () => { throw new Error('Storage unavailable'); };
    for (const unavailable of [null, { getItem: fail, setItem: fail, removeItem: fail }]) {
      expect(loadCachedSettings(unavailable, session.baseUrl)).toBeNull();
      expect(() => saveCachedSettings(unavailable, session.baseUrl, settings)).not.toThrow();
      expect(() => clearCachedSettings(unavailable, session.baseUrl)).not.toThrow();
    }
  });
});

it('provides the same tax rate for any tax class and preserves inclusion', () => {
  const context = taxContextFor(settings);
  expect(context.pricesIncludeTax).toBe(false);
  for (const taxClass of [undefined, '', 'standard', 'reduced']) expect(context.getTaxRatePpm(taxClass)).toBe(250000);
  expect(taxContextFor({ ...settings, pricesIncludeTax: true }).pricesIncludeTax).toBe(true);
});
