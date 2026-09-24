import { ratePpmFromPercent, type TaxContext } from '@tallyui/pos';
import type { Session, SessionStorage } from './session';
import { authHeaders } from './pos-connector';

export type StoreSettings = {
  storeName: string;
  currency: string;
  location: { id: string; name: string; addressLine?: string; countryCode: string };
  taxRatePpm: number;
  pricesIncludeTax: boolean;
};
export class StoreSettingsError extends Error {
  constructor(readonly code: 'unauthorized' | 'unreachable' | 'misconfigured', message: string) { super(message); }
}
const CACHE_PREFIX = 'medusapos.settings.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

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
  const taxes = await request(`/admin/tax-regions?country_code=${countryCode}&fields=id,country_code,province_code,parent_id,tax_rates.rate,tax_rates.is_default`);
  if (!Array.isArray(taxes.tax_regions)) throw new StoreSettingsError('unreachable', 'Invalid tax regions response.');
  const region = taxes.tax_regions.filter(isRecord).find((entry) =>
    entry.country_code === countryCode && entry.province_code == null && entry.parent_id == null);
  const rates = region && Array.isArray(region.tax_rates) ? region.tax_rates : [];
  const rate = rates.filter(isRecord).find((entry) => entry.is_default === true);
  let taxRatePpm = 0;
  if (rate) {
    if (typeof rate.rate !== 'number' && typeof rate.rate !== 'string') {
      throw new StoreSettingsError('misconfigured', 'Invalid default tax rate.');
    }
    taxRatePpm = ratePpmFromPercent(rate.rate);
  }
  const preferences = await request(`/admin/price-preferences?attribute=currency_code&value=${currency.toLowerCase()}&fields=id,is_tax_inclusive`);
  if (!Array.isArray(preferences.price_preferences)) throw new StoreSettingsError('unreachable', 'Invalid price preferences response.');
  const preference: unknown = preferences.price_preferences[0];
  return {
    storeName: store.name, currency,
    location: { id: location.id, name: location.name, addressLine, countryCode },
    taxRatePpm, pricesIncludeTax: isRecord(preference) && preference.is_tax_inclusive === true,
  };
}

export function loadCachedSettings(storage: SessionStorage | null, baseUrl: string): StoreSettings | null {
  try {
    const value: unknown = JSON.parse(storage?.getItem(CACHE_PREFIX + baseUrl) ?? 'null');
    if (!isRecord(value) || typeof value.storeName !== 'string' || typeof value.currency !== 'string'
      || typeof value.taxRatePpm !== 'number' || !Number.isSafeInteger(value.taxRatePpm) || value.taxRatePpm < 0
      || typeof value.pricesIncludeTax !== 'boolean') return null;
    const location = value.location;
    if (!isRecord(location) || typeof location.id !== 'string' || typeof location.name !== 'string'
      || typeof location.countryCode !== 'string'
      || (location.addressLine !== undefined && typeof location.addressLine !== 'string')) return null;
    return {
      storeName: value.storeName, currency: value.currency, taxRatePpm: value.taxRatePpm,
      pricesIncludeTax: value.pricesIncludeTax,
      location: { id: location.id, name: location.name, countryCode: location.countryCode, addressLine: location.addressLine },
    };
  } catch { return null; }
}

export function saveCachedSettings(storage: SessionStorage | null, baseUrl: string, settings: StoreSettings): void {
  try { storage?.setItem(CACHE_PREFIX + baseUrl, JSON.stringify(settings)); } catch { /* Web storage may be unavailable. */ }
}

export function clearCachedSettings(storage: SessionStorage | null, baseUrl: string): void {
  try { storage?.removeItem(CACHE_PREFIX + baseUrl); } catch { /* Web storage may be unavailable. */ }
}

export function taxContextFor(settings: StoreSettings): TaxContext {
  return { getTaxRatePpm: () => settings.taxRatePpm, pricesIncludeTax: settings.pricesIncludeTax };
}
