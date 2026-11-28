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

// The phone opens one section per page, named by the route's `section` param.
const { params } = vi.hoisted(() => ({ params: {} as { section?: string } }));
vi.mock('expo-router', () => ({
  Redirect: ({ href }: { href: string }) => <span>redirect:{href}</span>,
  router: { replace: vi.fn(), navigate: vi.fn(), push: vi.fn(), back: vi.fn(), canGoBack: vi.fn(() => false) },
  useLocalSearchParams: () => params,
  Stack: { Screen: ({ options }: { options: { headerLeft?: () => ReactNode; headerRight?: () => ReactNode } }) => <>
    <div data-testid="header-left">{options.headerLeft?.()}</div>
    {options.headerRight?.()}
  </> },
}));
vi.mock('expo-linking', () => ({ openURL: vi.fn().mockResolvedValue(true) }));
// Settings' Danger zone imports the approval dialog, which reads the locale.
vi.mock('expo-localization', () => ({ getLocales: () => [{ languageTag: 'en-GB' }] }));

const baseUrl = 'https://store.test';
const admin = `${baseUrl}/app/settings`;
const held: StoreSettings = {
  storeName: 'Test shop', currency: 'USD',
  location: { id: 'sloc_1', name: 'Copenhagen shop', addressLine: 'Nørregade 1, Copenhagen', countryCode: 'dk' },
  salesChannel: { id: 'sc_pos', name: 'Shop floor' },
  regions: [{ id: 'reg_dk', name: 'Denmark' }, { id: 'reg_eu', name: 'Europe' }],
  taxRates: [{ name: 'Standard', rate: 25, isDefault: true }, { name: 'Reduced', rate: 12.5, isDefault: false }],
};
const pricing: PricingSettings = {
  currency: 'EUR', pricesIncludeTax: true, taxRatesPpm: { default: 250000 },
  pricingContext: { region_id: 'reg_eu', currency_code: 'eur', publishable_key: 'pk_secret_test' },
};
let open: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  open = vi.spyOn(window, 'open').mockImplementation(() => null);
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
  saveCachedSettings(localStorage, baseUrl, held);
  saveCachedPricing(localStorage, baseUrl, pricing);
});

afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); delete params.section;
  act(() => setWindowWidth(0));
});

async function mount() {
  await act(async () => { render(<SessionProvider><SettingsScreen /></SessionProvider>); });
}

// Clicks one link and expects exactly one new tab, on that Admin page.
function expectOpens(link: HTMLElement, url: string) {
  open.mockClear();
  fireEvent.click(link);
  expect(open).toHaveBeenCalledTimes(1);
  expect(open).toHaveBeenCalledWith(url, '_blank', 'noopener,noreferrer');
}

describe('Settings › General and Tax: Open in Medusa Admin', () => {
  it('at 1024 px each admin row names Medusa Admin as its source', async () => {
    setWindowWidth(1024);
    await mount();
    for (const row of ['store-name', 'store-currency', 'store-location', 'store-sales-channel']) {
      expect(screen.getByTestId(`settings-${row}-admin-source`).textContent).toBe('Set in Medusa Admin');
      expect(screen.getByTestId(`settings-${row}-admin`).textContent).toBe('Open');
    }
    fireEvent.click(screen.getByTestId('settings-nav-tax'));
    for (const row of ['store-region', 'store-prices-include-tax', 'tax-rate-0', 'tax-rate-1']) {
      expect(screen.getByTestId(`settings-${row}-admin-source`).textContent).toBe('Set in Medusa Admin');
      expect(screen.getByTestId(`settings-${row}-admin`).textContent).toBe('Open');
    }
    cleanup();
    saveCachedSettings(localStorage, baseUrl, { ...held, taxRates: [] });
    await mount();
    fireEvent.click(screen.getByTestId('settings-nav-tax'));
    expect(screen.getByTestId('settings-tax-rates-admin-source').textContent).toBe('Set in Medusa Admin');
    expect(screen.getByTestId('settings-tax-rates-admin').textContent).toBe('Open');
  });

  it('below 1024 px the wide card keeps only Open', async () => {
    setWindowWidth(800);
    await mount();
    expect(screen.queryAllByTestId(/-admin-source$/)).toHaveLength(0);
    const card = within(screen.getByTestId('settings-section-card'));
    expect(card.getAllByRole('link', { name: /in Medusa Admin$/ }).map((link) => link.textContent))
      .toEqual(['Open', 'Open', 'Open', 'Open']);
  });

  it('a phone shows no source notes and no group dividers', async () => {
    setWindowWidth(390);
    params.section = 'store';
    await mount();
    expect(screen.getByTestId('settings-store-name-admin').textContent).toBe('Open');
    expect(screen.queryAllByTestId(/-admin-source$/)).toHaveLength(0);
    expect(screen.queryAllByTestId('settings-group-divider')).toHaveLength(0);
  });

  it('General draws a divider above every group after Store', async () => {
    setWindowWidth(1024);
    await mount();
    expect(screen.getAllByTestId('settings-group-divider')).toHaveLength(3);
    for (const group of ['settings-default-customer', 'settings-currency', 'settings-feedback']) {
      expect(within(screen.getByTestId(group)).getAllByTestId('settings-group-divider')).toHaveLength(1);
    }
    expect(within(screen.getByTestId('settings-store')).queryByTestId('settings-group-divider')).toBeNull();
    fireEvent.click(screen.getByTestId('settings-nav-tax'));
    expect(within(screen.getByTestId('settings-tax')).queryByTestId('settings-group-divider')).toBeNull();
  });

  it.each([
    ['Store name', 'settings-store-name-admin', `${admin}/store`],
    ['Currency', 'settings-store-currency-admin', `${admin}/regions`],
    ['Stock location', 'settings-store-location-admin', `${admin}/locations`],
    ['Sales channel', 'settings-store-sales-channel-admin', `${admin}/sales-channels`],
  ])('on a wide window, the %s row links to its Admin page', async (label, testID, url) => {
    setWindowWidth(1024);
    await mount();
    const link = within(screen.getByTestId('settings-store')).getByRole('link', { name: `Open ${label} in Medusa Admin` });
    expect(link.dataset.testid).toBe(testID);
    expect(link.textContent).toBe('Open');
    expectOpens(link, url);
  });

  it('on a wide window, the Tax rows link to the regions and tax regions pages', async () => {
    setWindowWidth(1024);
    await mount();
    fireEvent.click(screen.getByTestId('settings-nav-tax'));
    const tax = within(screen.getByTestId('settings-tax'));
    expect(tax.getByTestId('settings-store-region-admin').getAttribute('aria-label')).toBe('Open Region in Medusa Admin');
    expectOpens(tax.getByTestId('settings-store-region-admin'), `${admin}/regions`);
    expect(tax.getByTestId('settings-store-prices-include-tax-admin').getAttribute('aria-label')).toBe('Open Prices include tax in Medusa Admin');
    expectOpens(tax.getByTestId('settings-store-prices-include-tax-admin'), `${admin}/regions`);
    expect(tax.getByTestId('settings-tax-rate-0-admin').getAttribute('aria-label')).toBe('Open Standard in Medusa Admin');
    expectOpens(tax.getByTestId('settings-tax-rate-0-admin'), `${admin}/tax-regions`);
    expect(tax.getByTestId('settings-tax-rate-1-admin').getAttribute('aria-label')).toBe('Open Reduced in Medusa Admin');
    expectOpens(tax.getByTestId('settings-tax-rate-1-admin'), `${admin}/tax-regions`);
    expect(tax.queryByTestId('settings-tax-rates-admin')).toBeNull();
  });

  it('on a wide window with no tax rates, the Tax rates row links to the tax regions page', async () => {
    saveCachedSettings(localStorage, baseUrl, { ...held, taxRates: [] });
    setWindowWidth(1024);
    await mount();
    fireEvent.click(screen.getByTestId('settings-nav-tax'));
    expect(screen.getByTestId('settings-tax-rates-none').textContent).toBe('None');
    expect(screen.getByTestId('settings-tax-rates-admin').getAttribute('aria-label')).toBe('Open Tax rates in Medusa Admin');
    expectOpens(screen.getByTestId('settings-tax-rates-admin'), `${admin}/tax-regions`);
  });

  it('on a phone, the General and Tax section pages carry the same links', async () => {
    params.section = 'store';
    await mount();
    expect(within(screen.getByTestId('settings-store')).getAllByRole('link', { name: /in Medusa Admin$/ })
      .map((link) => link.dataset.testid)).toEqual(['settings-store-name-admin', 'settings-store-currency-admin',
      'settings-store-location-admin', 'settings-store-sales-channel-admin']);
    expectOpens(screen.getByRole('link', { name: 'Open Store name in Medusa Admin' }), `${admin}/store`);
    cleanup();
    params.section = 'tax';
    await mount();
    expect(within(screen.getByTestId('settings-tax')).getAllByRole('link').map((link) => link.dataset.testid))
      .toEqual(['settings-store-region-admin', 'settings-store-prices-include-tax-admin', 'settings-tax-rate-0-admin', 'settings-tax-rate-1-admin']);
    expectOpens(screen.getByRole('link', { name: 'Open Region in Medusa Admin' }), `${admin}/regions`);
  });

  it('keeps the value texts as they were, beside the link', async () => {
    setWindowWidth(1024);
    await mount();
    expect(screen.getByTestId('settings-store-name').textContent).toBe('Test shop');
    expect(screen.getByTestId('settings-store-location').textContent).toBe('Copenhagen shop');
    fireEvent.click(screen.getByTestId('settings-nav-tax'));
    expect(screen.getByTestId('settings-store-region').textContent).toBe('Europe');
    expect(screen.getByTestId('settings-tax-rate-0').textContent).toBe('25% · Default');
  });

  it('shows the link beside an unknown value too', async () => {
    saveCachedSettings(localStorage, baseUrl, { ...held, salesChannel: undefined });
    params.section = 'store';
    await mount();
    expect(screen.getByTestId('settings-store-sales-channel').textContent).toBe('—');
    expectOpens(screen.getByTestId('settings-store-sales-channel-admin'), `${admin}/sales-channels`);
  });

  it('adds no links to Currency & numbers', async () => {
    params.section = 'store';
    await mount();
    expect(within(screen.getByTestId('settings-currency')).queryAllByRole('link')).toEqual([]);
  });
});
