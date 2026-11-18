// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoreSettings as PricingSettings } from '@tallyui/core';
import { saveSession } from '../lib/session';
import { SessionProvider } from '../lib/session-context';
import { saveCachedSettings, saveCachedPricing, type StoreSettings } from '../lib/store-settings';
import SettingsScreen from '../app/settings';
import { setWindowWidth } from './window-width';

vi.mock('expo-router', () => ({
  Redirect: ({ href }: { href: string }) => <span>redirect:{href}</span>,
  router: { replace: vi.fn(), navigate: vi.fn(), back: vi.fn(), canGoBack: vi.fn(() => false) },
  Stack: { Screen: ({ options }: { options: { headerLeft?: () => ReactNode; headerRight?: () => ReactNode } }) => <>
    <div data-testid="header-left">{options.headerLeft?.()}</div>
    {options.headerRight?.()}
  </> },
}));
vi.mock('expo-linking', () => ({ openURL: vi.fn().mockResolvedValue(true) }));

const baseUrl = 'https://store.test';
const held: StoreSettings = {
  storeName: 'Test shop', currency: 'USD',
  location: { id: 'sloc_1', name: 'Copenhagen shop', addressLine: 'Nørregade 1, Copenhagen', countryCode: 'dk' },
  regions: [{ id: 'reg_dk', name: 'Denmark' }, { id: 'reg_eu', name: 'Europe' }],
};
const withRates: StoreSettings = {
  ...held, taxRates: [{ name: 'Standard', rate: 25, isDefault: true }, { name: 'Reduced', rate: 12.5, isDefault: false }],
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
  vi.stubGlobal('fetch', vi.fn());
  saveSession(localStorage, {
    baseUrl, email: 'admin@store.test',
    token: `header.${btoa(JSON.stringify({ exp: Date.now() / 1000 + 86400 }))}.signature`,
  });
});

afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); act(() => setWindowWidth(0)); });

async function mount(children: ReactNode = <SettingsScreen />) {
  let view!: ReturnType<typeof render>;
  await act(async () => { view = render(<SessionProvider>{children}</SessionProvider>); });
  return view;
}
const follows = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe('Settings › Tax', () => {
  it("on a wide window shows the till's region, tax inclusivity and tax rates under Tax, and none of them under General", async () => {
    saveCachedSettings(localStorage, baseUrl, withRates);
    saveCachedPricing(localStorage, baseUrl, pricing);
    setWindowWidth(1280, 800);
    await mount();
    const store = screen.getByTestId('settings-store');
    expect(within(store).queryByTestId('settings-store-region')).toBeNull();
    expect(within(store).queryByTestId('settings-store-prices-include-tax')).toBeNull();
    fireEvent.click(screen.getByTestId('settings-nav-tax'));
    expect(screen.queryByTestId('settings-store')).toBeNull();
    const tax = within(screen.getByTestId('settings-tax'));
    expect(tax.getByText('Read-only. Set per region in Medusa Admin.')).toBeTruthy();
    expect(tax.getByTestId('settings-store-region').textContent).toBe('Europe');
    expect(tax.getByTestId('settings-store-prices-include-tax').textContent).toBe('Yes');
    const standard = tax.getByTestId('settings-tax-rate-0');
    const reduced = tax.getByTestId('settings-tax-rate-1');
    expect(standard.textContent).toBe('25% · Default');
    expect(reduced.textContent).toBe('12.5%');
    expect(follows(tax.getByText('Standard'), standard)).toBe(true);
    expect(follows(standard, tax.getByText('Reduced'))).toBe(true);
    expect(follows(tax.getByText('Reduced'), reduced)).toBe(true);
    expect(tax.queryByTestId('settings-tax-rates-none')).toBeNull();
  });

  it('an older cache without tax rates shows —, and a region with no rates shows None', async () => {
    saveCachedSettings(localStorage, baseUrl, held);
    saveCachedPricing(localStorage, baseUrl, pricing);
    await mount();
    expect(screen.getByTestId('settings-tax-rates-none').textContent).toBe('—');
    expect(screen.queryByTestId('settings-tax-rate-0')).toBeNull();
    cleanup();
    saveCachedSettings(localStorage, baseUrl, { ...held, taxRates: [] });
    await mount();
    expect(screen.getByTestId('settings-tax-rates-none').textContent).toBe('None');
  });

  it('never shows the publishable key from the cached pricing context', async () => {
    saveCachedSettings(localStorage, baseUrl, withRates);
    saveCachedPricing(localStorage, baseUrl, pricing);
    setWindowWidth(1280, 800);
    await mount();
    fireEvent.click(screen.getByTestId('settings-nav-tax'));
    expect(screen.getByTestId('settings-tax')).toBeTruthy();
    expect(screen.queryByText(/pk_secret_test/)).toBeNull();
  });
});
