// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoreSettings as PricingSettings } from '@tallyui/core';
import { saveSession } from '../lib/session';
import { SessionProvider } from '../lib/session-context';
import { saveCachedSettings, saveCachedPricing, type StoreSettings } from '../lib/store-settings';
import SettingsScreen from '../app/settings';

vi.mock('expo-router', () => ({
  Redirect: ({ href }: { href: string }) => <span>redirect:{href}</span>,
  router: { replace: vi.fn(), navigate: vi.fn(), back: vi.fn(), canGoBack: vi.fn(() => false) },
  Stack: { Screen: ({ options }: { options: { headerLeft?: () => ReactNode; headerRight?: () => ReactNode } }) => <>
    <div data-testid="header-left">{options.headerLeft?.()}</div>
    {options.headerRight?.()}
  </> },
}));

const baseUrl = 'https://store.test';
const fetchSpy = vi.fn();
const held: StoreSettings = {
  storeName: 'Test shop', currency: 'USD',
  location: { id: 'sloc_1', name: 'Copenhagen shop', addressLine: 'Nørregade 1, Copenhagen', countryCode: 'dk' },
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

afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

async function mount(children: ReactNode = <SettingsScreen />) {
  let view!: ReturnType<typeof render>;
  await act(async () => { view = render(<SessionProvider>{children}</SessionProvider>); });
  return view;
}

describe('SettingsScreen Store section', () => {
  it('shows the Store, Register and Scanner sections, Store first', async () => {
    saveCachedSettings(localStorage, baseUrl, held);
    saveCachedPricing(localStorage, baseUrl, pricing);
    await mount();
    expect(screen.getByText('Store')).toBeTruthy();
    expect(screen.getByText('Register')).toBeTruthy();
    expect(screen.getByText('Scanner')).toBeTruthy();
    const store = screen.getByTestId('settings-store');
    const register = screen.getByTestId('settings-register');
    const scanner = screen.getByTestId('settings-scanner');
    expect(store.compareDocumentPosition(register) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(register.compareDocumentPosition(scanner) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows the cached store, currency, tax inclusivity and location', async () => {
    saveCachedSettings(localStorage, baseUrl, held);
    saveCachedPricing(localStorage, baseUrl, pricing);
    await mount();
    expect(screen.getByTestId('settings-store-name').textContent).toBe('Test shop');
    expect(screen.getByTestId('settings-store-currency').textContent).toBe('EUR');
    expect(screen.getByTestId('settings-store-prices-include-tax').textContent).toBe('Yes');
    expect(screen.getByTestId('settings-store-location').textContent).toBe('Copenhagen shop');
    expect(screen.getByTestId('settings-store-location-address').textContent).toBe('Nørregade 1, Copenhagen');
    expect(screen.getByText('Read-only. Set in Medusa Admin.')).toBeTruthy();
  });

  it("never shows the publishable key or the store's default currency", async () => {
    saveCachedSettings(localStorage, baseUrl, held);
    saveCachedPricing(localStorage, baseUrl, pricing);
    await mount();
    expect(screen.queryByText(/pk_secret_test/)).toBeNull();
    expect(screen.queryByText('USD')).toBeNull();
  });

  it('prices that exclude tax show No', async () => {
    saveCachedPricing(localStorage, baseUrl, { ...pricing, pricesIncludeTax: false });
    await mount();
    expect(screen.getByTestId('settings-store-prices-include-tax').textContent).toBe('No');
  });

  it('with nothing cached, every Store row shows —', async () => {
    await mount();
    for (const id of ['settings-store-name', 'settings-store-currency', 'settings-store-prices-include-tax', 'settings-store-location']) {
      expect(screen.getByTestId(id).textContent).toBe('—');
    }
    expect(screen.queryByTestId('settings-store-location-address')).toBeNull();
  });

  it('a location without an address shows no address line', async () => {
    saveCachedSettings(localStorage, baseUrl, {
      ...held, location: { id: 'sloc_1', name: 'Copenhagen shop', countryCode: 'dk' },
    });
    saveCachedPricing(localStorage, baseUrl, pricing);
    await mount();
    expect(screen.getByTestId('settings-store-location').textContent).toBe('Copenhagen shop');
    expect(screen.queryByTestId('settings-store-location-address')).toBeNull();
  });

  it('opening Settings makes no network request', async () => {
    saveCachedSettings(localStorage, baseUrl, held);
    saveCachedPricing(localStorage, baseUrl, pricing);
    await mount();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
