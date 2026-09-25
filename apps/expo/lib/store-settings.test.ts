import { describe, expect, it, vi } from 'vitest';
import type { SessionStorage } from './session';
import type { StoreSettings as PricingSettings } from '@tallyui/core';
import {
  clearCachedSettings, clearSettingsRegion, fetchStoreSettings, loadCachedPricing, loadCachedSettings, loadSettingsChoice,
  saveCachedPricing, saveCachedSettings, saveSettingsChoice, StoreSettingsError, type StoreSettings,
} from './store-settings';

const session = { baseUrl: 'http://localhost:9000', email: 'admin@tally.test', token: 'jwt' };
const settings: StoreSettings = {
  storeName: 'Default Store', currency: 'EUR',
  location: { id: 'loc_1', name: 'European Warehouse', addressLine: 'Street 1, Copenhagen', countryCode: 'dk' },
};
const pricing: PricingSettings = {
  currency: 'EUR', pricesIncludeTax: true, taxRatesPpm: { default: 190000, reduced: 70000 },
  pricingContext: { region_id: 'reg_de', currency_code: 'eur', publishable_key: 'pk_1' },
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
  it('reads only the store name, default currency and first location, with no tax or price-preference reads', async () => {
    const fetchImpl = fetcher();
    expect(await fetchStoreSettings(session, fetchImpl)).toEqual(settings);
    expect(fetchImpl.mock.calls).toEqual([
      '/admin/stores?fields=id,name,default_sales_channel_id,supported_currencies.currency_code,supported_currencies.is_default',
      '/admin/sales-channels/sc_1?fields=id,name,stock_locations.id,stock_locations.name,stock_locations.address.*',
    ].map((path) => [`${session.baseUrl}${path}`, { headers: { Authorization: 'Bearer jwt' } }]));
  });
  it.each([0, 1])('maps a 401 at resource %s to unauthorized', async (index) => {
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
  it('accepts an older entry that still carries taxRatePpm and pricesIncludeTax, without them', () => {
    const storage = memoryStorage();
    storage.setItem(`medusapos.settings.${session.baseUrl}`, JSON.stringify({ ...settings, taxRatePpm: 250000, pricesIncludeTax: false }));
    expect(loadCachedSettings(storage, session.baseUrl)).toEqual(settings);
  });
  it.each([
    '{', 'null', '{}', '[]', JSON.stringify({ ...settings, currency: 42 }),
    JSON.stringify({ ...settings, storeName: undefined }),
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

describe('store settings choice', () => {
  it('round-trips only the region and channel, per backend, under its own key', () => {
    const storage = memoryStorage();
    expect(loadSettingsChoice(storage, session.baseUrl)).toBeUndefined();
    saveSettingsChoice(storage, session.baseUrl, { region: 'reg_eu', country: 'de', channel: 'pk_1' });
    expect(JSON.parse(storage.getItem(`medusapos.settings-choice.${session.baseUrl}`)!)).toEqual({ region: 'reg_eu', channel: 'pk_1' });
    expect(loadSettingsChoice(storage, session.baseUrl)).toEqual({ region: 'reg_eu', channel: 'pk_1' });
    expect(loadSettingsChoice(storage, 'https://other.test')).toBeUndefined();
    saveSettingsChoice(storage, session.baseUrl, { region: 'reg_eu' });
    expect(loadSettingsChoice(storage, session.baseUrl)).toEqual({ region: 'reg_eu' });
  });
  it('clears only the stored region', () => {
    const storage = memoryStorage();
    saveSettingsChoice(storage, session.baseUrl, { region: 'reg_de', channel: 'pk_1' });
    clearSettingsRegion(storage, session.baseUrl);
    expect(loadSettingsChoice(storage, session.baseUrl)).toEqual({ channel: 'pk_1' });
  });
  it.each(['{', 'null', '[]', '"reg_eu"', JSON.stringify({ region: 42 }), JSON.stringify({ region: 'reg_eu', channel: null })])(
    'rejects a malformed stored choice %s', (value) => {
      const storage = memoryStorage();
      storage.setItem(`medusapos.settings-choice.${session.baseUrl}`, value);
      expect(loadSettingsChoice(storage, session.baseUrl)).toBeUndefined();
    },
  );
  it('lets a failing save throw, so useStoreSettings reports it, and tolerates unavailable storage when reading', () => {
    const fail = () => { throw new Error('Storage unavailable'); };
    const unavailable = { getItem: fail, setItem: fail, removeItem: fail };
    expect(() => saveSettingsChoice(unavailable, session.baseUrl, { region: 'reg_eu' })).toThrow('Storage unavailable');
    expect(loadSettingsChoice(unavailable, session.baseUrl)).toBeUndefined();
    expect(() => clearSettingsRegion(unavailable, session.baseUrl)).not.toThrow();
    expect(() => saveSettingsChoice(null, session.baseUrl, { region: 'reg_eu' })).not.toThrow();
  });
});

describe('pricing cache', () => {
  it('round-trips per backend, with and without a pricing context', () => {
    const storage = memoryStorage();
    expect(loadCachedPricing(storage, session.baseUrl)).toBeNull();
    saveCachedPricing(storage, session.baseUrl, pricing);
    const { pricingContext: _, ...withoutContext } = pricing;
    saveCachedPricing(storage, 'https://other.test', withoutContext);
    expect(storage.getItem(`medusapos.pricing.${session.baseUrl}`)).toBe(JSON.stringify(pricing));
    expect(loadCachedPricing(storage, session.baseUrl)).toEqual(pricing);
    expect(loadCachedPricing(storage, 'https://other.test')).toEqual(withoutContext);
  });
  it.each([
    '{', 'null', '{}', '[]', JSON.stringify({ ...pricing, currency: 1 }),
    JSON.stringify({ ...pricing, pricesIncludeTax: 'true' }),
    JSON.stringify({ ...pricing, taxRatesPpm: undefined }),
    JSON.stringify({ ...pricing, taxRatesPpm: [] }),
    JSON.stringify({ ...pricing, taxRatesPpm: { reduced: 70000 } }),
    JSON.stringify({ ...pricing, taxRatesPpm: { default: 19.5 } }),
    JSON.stringify({ ...pricing, taxRatesPpm: { default: -1 } }),
    JSON.stringify({ ...pricing, taxRatesPpm: { default: 190000, reduced: '70000' } }),
    JSON.stringify({ ...pricing, pricingContext: { region_id: 42 } }),
    JSON.stringify({ ...pricing, pricingContext: ['reg_de'] }),
  ])('rejects malformed cached pricing %s', (value) => {
    const storage = memoryStorage();
    storage.setItem(`medusapos.pricing.${session.baseUrl}`, value);
    expect(loadCachedPricing(storage, session.baseUrl)).toBeNull();
  });
  it('tolerates unavailable storage', () => {
    const fail = () => { throw new Error('Storage unavailable'); };
    for (const unavailable of [null, { getItem: fail, setItem: fail, removeItem: fail }]) {
      expect(loadCachedPricing(unavailable, session.baseUrl)).toBeNull();
      expect(() => saveCachedPricing(unavailable, session.baseUrl, pricing)).not.toThrow();
    }
  });
});
