// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { currencySymbol, type StoreSettings as PricingSettings } from '@tallyui/core';
import { currencyFormat, separatorLabel } from '../lib/currency-format';
import { saveSession } from '../lib/session';
import { SessionProvider } from '../lib/session-context';
import { saveCachedSettings, saveCachedPricing, type StoreSettings } from '../lib/store-settings';
import SettingsScreen from '../app/settings';

// The phone opens one section per page, named by the route's `section` param.
const { params } = vi.hoisted(() => ({ params: {} as { section?: string } }));
vi.mock('expo-router', () => ({
  Redirect: ({ href }: { href: string }) => <span>redirect:{href}</span>,
  router: { replace: vi.fn(), navigate: vi.fn(), back: vi.fn(), canGoBack: vi.fn(() => false) },
  useLocalSearchParams: () => params,
  Stack: { Screen: ({ options }: { options: { headerLeft?: () => ReactNode; headerRight?: () => ReactNode } }) => <>
    <div data-testid="header-left">{options.headerLeft?.()}</div>
    {options.headerRight?.()}
  </> },
}));
vi.mock('expo-linking', () => ({ openURL: vi.fn().mockResolvedValue(true) }));

const baseUrl = 'https://store.test';
const fetchSpy = vi.fn();
const held: StoreSettings = {
  storeName: 'Test shop', currency: 'USD',
  location: { id: 'sloc_1', name: 'Copenhagen shop', addressLine: 'Nørregade 1, Copenhagen', countryCode: 'dk' },
};
const named: StoreSettings = {
  ...held, salesChannel: { id: 'sc_pos', name: 'Shop floor' },
  regions: [{ id: 'reg_dk', name: 'Denmark' }, { id: 'reg_eu', name: 'Europe' }],
};
const pricing: PricingSettings = {
  currency: 'EUR', pricesIncludeTax: true, taxRatesPpm: { default: 250000 },
  pricingContext: { region_id: 'reg_eu', currency_code: 'eur', publishable_key: 'pk_secret_test' },
};

beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  });
  vi.stubGlobal('fetch', fetchSpy);
  saveSession(localStorage, {
    baseUrl, email: 'admin@store.test',
    token: `header.${btoa(JSON.stringify({ exp: Date.now() / 1000 + 86400 }))}.signature`,
  });
});

afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); delete params.section; });

async function mount(children: ReactNode = <SettingsScreen />) {
  let view!: ReturnType<typeof render>;
  await act(async () => { view = render(<SessionProvider>{children}</SessionProvider>); });
  return view;
}

// Opens one section's own phone page (General is `store`; Region and Prices include tax are on Tax).
async function mountSection(section: string) {
  cleanup();
  params.section = section;
  return mount();
}

describe('SettingsScreen Store section', () => {
  it('shows the Store, Register and Scanner sections, Store first', async () => {
    saveCachedSettings(localStorage, baseUrl, held);
    saveCachedPricing(localStorage, baseUrl, pricing);
    await mount();
    expect(screen.getByTestId('settings-list-store').textContent).toBe('General');
    expect(screen.getByText('Register')).toBeTruthy();
    expect(screen.getByText('Barcode Scanning')).toBeTruthy();
    const store = screen.getByTestId('settings-list-store');
    const tax = screen.getByTestId('settings-list-tax');
    const register = screen.getByTestId('settings-list-register');
    const scanner = screen.getByTestId('settings-list-scanner');
    expect(store.compareDocumentPosition(tax) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(tax.compareDocumentPosition(scanner) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(scanner.compareDocumentPosition(register) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await mountSection('store');
    expect(screen.getByText('Store')).toBeTruthy();
  });

  it('shows the cached store, currency, tax inclusivity and location', async () => {
    saveCachedSettings(localStorage, baseUrl, held);
    saveCachedPricing(localStorage, baseUrl, pricing);
    await mountSection('store');
    expect(screen.getByTestId('settings-store-name').textContent).toBe('Test shop');
    expect(screen.getByTestId('settings-store-currency').textContent).toBe('EUR');
    expect(screen.getByTestId('settings-store-location').textContent).toBe('Copenhagen shop');
    expect(screen.getByTestId('settings-store-location-address').textContent).toBe('Nørregade 1, Copenhagen');
    expect(screen.getByText('Read-only. Set in Medusa Admin.')).toBeTruthy();
    await mountSection('tax');
    expect(screen.getByTestId('settings-store-prices-include-tax').textContent).toBe('Yes');
  });

  it("never shows the publishable key or the store's default currency", async () => {
    saveCachedSettings(localStorage, baseUrl, held);
    saveCachedPricing(localStorage, baseUrl, pricing);
    for (const section of ['store', 'tax', 'printing', 'card-readers', 'scanner', 'theme', 'register', 'danger']) {
      await mountSection(section);
      expect(screen.queryByText(/pk_secret_test/)).toBeNull();
      expect(screen.queryByText('USD')).toBeNull();
    }
  });

  it("shows the till's region and the sales channel by name", async () => {
    saveCachedSettings(localStorage, baseUrl, named);
    saveCachedPricing(localStorage, baseUrl, pricing);
    await mountSection('tax');
    const region = screen.getByTestId('settings-store-region');
    expect(region.textContent).toBe('Europe');
    expect(screen.queryByText(/reg_eu/)).toBeNull();
    expect(screen.queryByText(/pk_secret_test/)).toBeNull();
    const tax = within(screen.getByTestId('settings-tax'));
    expect(tax.getByTestId('settings-store-region')).toBe(region);
    expect(region.compareDocumentPosition(tax.getByTestId('settings-store-prices-include-tax')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await mountSection('store');
    const channel = screen.getByTestId('settings-store-sales-channel');
    expect(channel.textContent).toBe('Shop floor');
    expect(screen.queryByText(/sc_pos/)).toBeNull();
    expect(screen.queryByText(/pk_secret_test/)).toBeNull();
    expect(screen.getByTestId('settings-store-location').compareDocumentPosition(channel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('an older cache without names shows — for Region and Sales channel', async () => {
    saveCachedSettings(localStorage, baseUrl, held);
    saveCachedPricing(localStorage, baseUrl, pricing);
    await mountSection('tax');
    expect(screen.getByTestId('settings-store-region').textContent).toBe('—');
    await mountSection('store');
    expect(screen.getByTestId('settings-store-sales-channel').textContent).toBe('—');
    expect(screen.getByTestId('settings-store-name').textContent).toBe('Test shop');
  });

  it("a region the till's pricing does not name shows —", async () => {
    saveCachedSettings(localStorage, baseUrl, { ...named, regions: [{ id: 'reg_dk', name: 'Denmark' }] });
    saveCachedPricing(localStorage, baseUrl, pricing);
    await mountSection('tax');
    expect(screen.getByTestId('settings-store-region').textContent).toBe('—');
    cleanup();
    const { pricingContext: _, ...withoutContext } = pricing;
    saveCachedSettings(localStorage, baseUrl, named);
    saveCachedPricing(localStorage, baseUrl, withoutContext);
    await mountSection('tax');
    expect(screen.getByTestId('settings-store-region').textContent).toBe('—');
  });

  it('prices that exclude tax show No', async () => {
    saveCachedPricing(localStorage, baseUrl, { ...pricing, pricesIncludeTax: false });
    await mountSection('tax');
    expect(screen.getByTestId('settings-store-prices-include-tax').textContent).toBe('No');
  });

  it('with nothing cached, every Store row shows —', async () => {
    await mountSection('store');
    for (const id of ['settings-store-name', 'settings-store-currency', 'settings-store-location', 'settings-store-sales-channel']) {
      expect(screen.getByTestId(id).textContent).toBe('—');
    }
    expect(screen.queryByTestId('settings-store-location-address')).toBeNull();
    await mountSection('tax');
    for (const id of ['settings-store-region', 'settings-store-prices-include-tax']) {
      expect(screen.getByTestId(id).textContent).toBe('—');
    }
  });

  it('a location without an address shows no address line', async () => {
    saveCachedSettings(localStorage, baseUrl, {
      ...held, location: { id: 'sloc_1', name: 'Copenhagen shop', countryCode: 'dk' },
    });
    saveCachedPricing(localStorage, baseUrl, pricing);
    await mountSection('store');
    expect(screen.getByTestId('settings-store-location').textContent).toBe('Copenhagen shop');
    expect(screen.queryByTestId('settings-store-location-address')).toBeNull();
  });

  it('opening Settings makes no network request', async () => {
    saveCachedSettings(localStorage, baseUrl, held);
    saveCachedPricing(localStorage, baseUrl, pricing);
    await mount();
    await mountSection('store');
    await mountSection('tax');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("shows the till's currency format under Store, read-only", async () => {
    saveCachedSettings(localStorage, baseUrl, held);
    saveCachedPricing(localStorage, baseUrl, pricing);
    await mountSection('store');
    const format = currencyFormat('EUR')!;
    expect(screen.getByTestId('settings-store').compareDocumentPosition(screen.getByTestId('settings-currency')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId('settings-currency-symbol').textContent).toBe(currencySymbol('EUR'));
    expect(screen.getByTestId('settings-currency-decimals').textContent).toBe('2');
    expect(screen.getByTestId('settings-currency-example').textContent).toBe(format.example);
    expect(screen.getByTestId('settings-currency-thousands').textContent).toBe(separatorLabel(format.thousandsSeparator));
    expect(screen.getByTestId('settings-currency-decimal').textContent).toBe(separatorLabel(format.decimalSeparator));
    expect(screen.getByText("Read-only. The currency follows the till's region, set in Medusa Admin; separators follow this device's language.")).toBeTruthy();
  });

  it('a zero-decimal currency shows 0 decimals and no decimal separator', async () => {
    saveCachedPricing(localStorage, baseUrl, { ...pricing, currency: 'JPY' });
    await mountSection('store');
    expect(screen.getByTestId('settings-currency-decimals').textContent).toBe('0');
    expect(screen.getByTestId('settings-currency-decimal').textContent).toBe('None');
  });

  it('with nothing cached, every currency-format row shows —', async () => {
    await mountSection('store');
    for (const id of ['settings-currency-symbol', 'settings-currency-position', 'settings-currency-thousands', 'settings-currency-decimal', 'settings-currency-decimals', 'settings-currency-example']) {
      expect(screen.getByTestId(id).textContent).toBe('—');
    }
  });
});
