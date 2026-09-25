import type { StoreSettings as PricingSettings, StoreSettingsChoice } from '@tallyui/core';
import type { Session, SessionStorage } from './session';
import { authHeaders } from './pos-connector';

export type StoreSettings = {
  storeName: string;
  currency: string;
  location: { id: string; name: string; addressLine?: string; countryCode: string };
};
export class StoreSettingsError extends Error {
  constructor(readonly code: 'unauthorized' | 'unreachable' | 'misconfigured', message: string) { super(message); }
}
const CACHE_PREFIX = 'medusapos.settings.';
// Per store, like the settings cache; signing out clears neither.
const CHOICE_PREFIX = 'medusapos.settings-choice.';
const PRICING_PREFIX = 'medusapos.pricing.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
function isStrings(value: unknown): value is Record<string, string> {
  return isRecord(value) && !Array.isArray(value) && Object.values(value).every((entry) => typeof entry === 'string');
}
const isPpm = (rate: unknown) => typeof rate === 'number' && Number.isSafeInteger(rate) && rate >= 0;

export async function fetchStoreSettings(session: Session, fetchImpl = globalThis.fetch): Promise<StoreSettings> {
  async function request(path: string): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetchImpl(`${session.baseUrl}${path}`, { headers: authHeaders(session.token) });
    } catch { throw new StoreSettingsError('unreachable', 'Could not reach the backend.'); }
    if (response.status === 401) throw new StoreSettingsError('unauthorized', 'Please sign in again.');
    if (!response.ok) throw new StoreSettingsError('unreachable', 'Could not read store settings.');
    const body: unknown = await response.json().catch(() => null);
    if (!isRecord(body)) throw new StoreSettingsError('unreachable', 'Invalid store settings response.');
    return body;
  }

  const stores = await request('/admin/stores?fields=id,name,default_sales_channel_id,supported_currencies.currency_code,supported_currencies.is_default');
  const store: unknown = Array.isArray(stores.stores) ? stores.stores[0] : undefined;
  const currencies = isRecord(store) && Array.isArray(store.supported_currencies) ? store.supported_currencies : [];
  const defaultCurrency = currencies.filter(isRecord).find((entry) => entry.is_default === true);
  if (!defaultCurrency || typeof defaultCurrency.currency_code !== 'string' || !defaultCurrency.currency_code) {
    throw new StoreSettingsError('misconfigured', 'No default currency configured.');
  }
  if (!isRecord(store) || typeof store.default_sales_channel_id !== 'string' || !store.default_sales_channel_id) {
    throw new StoreSettingsError('misconfigured', 'No default sales channel configured.');
  }
  if (typeof store.name !== 'string') throw new StoreSettingsError('misconfigured', 'No store name configured.');
  const currency = defaultCurrency.currency_code.toUpperCase();
  const channel = await request(`/admin/sales-channels/${store.default_sales_channel_id}?fields=id,name,stock_locations.id,stock_locations.name,stock_locations.address.*`);
  const locations = isRecord(channel.sales_channel) ? channel.sales_channel.stock_locations : undefined;
  const location: unknown = Array.isArray(locations) ? locations[0] : undefined;
  if (!isRecord(location) || typeof location.id !== 'string' || typeof location.name !== 'string') {
    throw new StoreSettingsError('misconfigured', 'No stock location on the default sales channel.');
  }
  const address = location.address;
  if (!isRecord(address) || typeof address.country_code !== 'string' || !address.country_code) {
    throw new StoreSettingsError('misconfigured', 'The stock location has no country code.');
  }
  const countryCode = address.country_code.toLowerCase();
  const addressLine = [address.address_1, address.city].filter((part) => typeof part === 'string' && part).join(', ') || undefined;
  // Tax, tax inclusivity and the sale currency come from TallyUI's store settings (TV4), not from here.
  return {
    storeName: store.name, currency,
    location: { id: location.id, name: location.name, addressLine, countryCode },
  };
}

export function loadCachedSettings(storage: SessionStorage | null, baseUrl: string): StoreSettings | null {
  try {
    const value: unknown = JSON.parse(storage?.getItem(CACHE_PREFIX + baseUrl) ?? 'null');
    // An older entry may still carry taxRatePpm and pricesIncludeTax; they are ignored.
    if (!isRecord(value) || typeof value.storeName !== 'string' || typeof value.currency !== 'string') return null;
    const location = value.location;
    if (!isRecord(location) || typeof location.id !== 'string' || typeof location.name !== 'string'
      || typeof location.countryCode !== 'string'
      || (location.addressLine !== undefined && typeof location.addressLine !== 'string')) return null;
    return {
      storeName: value.storeName, currency: value.currency,
      location: { id: location.id, name: location.name, countryCode: location.countryCode, addressLine: location.addressLine },
    };
  } catch { return null; }
}

/** The till's stored region and channel for this store; the country always follows the stock location (D1). */
export function loadSettingsChoice(storage: SessionStorage | null, baseUrl: string): StoreSettingsChoice | undefined {
  try {
    const value: unknown = JSON.parse(storage?.getItem(CHOICE_PREFIX + baseUrl) ?? 'null');
    if (!isStrings(value)) return undefined;
    return { ...(value.region !== undefined && { region: value.region }), ...(value.channel !== undefined && { channel: value.channel }) };
  } catch { return undefined; }
}

/** Throws when storage does, so useStoreSettings reports it through onSaveError. */
export function saveSettingsChoice(storage: SessionStorage | null, baseUrl: string, choice: StoreSettingsChoice): void {
  storage?.setItem(CHOICE_PREFIX + baseUrl, JSON.stringify({ region: choice.region, channel: choice.channel }));
}

export function clearSettingsRegion(storage: SessionStorage | null, baseUrl: string): void {
  try { saveSettingsChoice(storage, baseUrl, { ...loadSettingsChoice(storage, baseUrl), region: undefined }); } catch { /* Web storage may be unavailable. */ }
}

/** The last resolved TallyUI store settings, so the till opens offline (D3). The publishable key in it is public. */
export function loadCachedPricing(storage: SessionStorage | null, baseUrl: string): PricingSettings | null {
  try {
    const value: unknown = JSON.parse(storage?.getItem(PRICING_PREFIX + baseUrl) ?? 'null');
    if (!isRecord(value) || typeof value.currency !== 'string' || typeof value.pricesIncludeTax !== 'boolean'
      || !isRecord(value.taxRatesPpm) || Array.isArray(value.taxRatesPpm) || !isPpm(value.taxRatesPpm.default)
      || !Object.values(value.taxRatesPpm).every(isPpm)
      || (value.pricingContext !== undefined && !isStrings(value.pricingContext))) return null;
    return {
      currency: value.currency, pricesIncludeTax: value.pricesIncludeTax,
      taxRatesPpm: value.taxRatesPpm as PricingSettings['taxRatesPpm'],
      ...(value.pricingContext !== undefined && { pricingContext: value.pricingContext }),
    };
  } catch { return null; }
}

export function saveCachedPricing(storage: SessionStorage | null, baseUrl: string, settings: PricingSettings): void {
  try { storage?.setItem(PRICING_PREFIX + baseUrl, JSON.stringify(settings)); } catch { /* Web storage may be unavailable. */ }
}

export function saveCachedSettings(storage: SessionStorage | null, baseUrl: string, settings: StoreSettings): void {
  try { storage?.setItem(CACHE_PREFIX + baseUrl, JSON.stringify(settings)); } catch { /* Web storage may be unavailable. */ }
}

export function clearCachedSettings(storage: SessionStorage | null, baseUrl: string): void {
  try { storage?.removeItem(CACHE_PREFIX + baseUrl); } catch { /* Web storage may be unavailable. */ }
}
