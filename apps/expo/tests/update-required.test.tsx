// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoreSettings as PricingSettings } from '@tallyui/core';
import ProductsScreen from '../app/index';
import { setWindowWidth } from './window-width';
import { useOutboxContext } from '../lib/outbox-context';
import { capabilities, storeSettings } from './pos-connector-mock';
import { useSession } from '../lib/session-context';
import { sessionFixture } from './session-fixture';
import { fetchStoreSettings, type StoreSettings } from '../lib/store-settings';
import { useReplicatedProducts } from '../lib/use-replicated-products';
import { useRegister } from '../lib/register-context';
import { openRegisterFixture } from './register-fixture';
import { readPluginContract, type PluginContractStatus } from '../lib/plugin-contract';

vi.mock('../lib/pos-connector', async (importOriginal) => (await import('./pos-connector-mock')).mockPosConnector(importOriginal));
vi.mock('expo-router', () => ({ usePathname: () => '/', Redirect: () => null, router: { replace: vi.fn(), push: vi.fn() }, Stack: { Screen: () => null } }));
// expo-localization's native module isn't available under vitest.
vi.mock('expo-localization', () => ({ getCalendars: () => [{ uses24hourClock: null }] }));
vi.mock('../lib/session-context', () => ({ useSession: vi.fn() }));
vi.mock('../lib/outbox-context', () => ({ useOutboxContext: vi.fn() }));
vi.mock('../lib/use-replicated-products', () => ({ useReplicatedProducts: vi.fn() }));
vi.mock('../lib/register-context', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/register-context')>(), useRegister: vi.fn(),
}));
vi.mock('../lib/store-settings', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/store-settings')>(), fetchStoreSettings: vi.fn(),
}));
// The /info read is this file's subject: each test states what it returns.
vi.mock('../lib/plugin-contract', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/plugin-contract')>(), readPluginContract: vi.fn(),
}));

const session = { baseUrl: 'https://store.test', email: 'cashier@store.test', token: 'jwt' };
const settings: StoreSettings = {
  storeName: 'Test shop', currency: 'EUR', location: { id: 'loc', name: 'Copenhagen', countryCode: 'dk' },
};
const pricing: PricingSettings = {
  currency: 'EUR', pricesIncludeTax: false, taxRatesPpm: { default: 250000 },
  pricingContext: { region_id: 'reg_eu', currency_code: 'eur', publishable_key: 'pk_1' },
};
const shirt = { id: 'shirt', title: 'Shirt', status: 'published',
  variants: [{ id: 'blue', title: 'Blue', sku: 'BLUE', prices: [{ amount: 12, currency_code: 'eur' }] }] };
const pos = () => screen.findByRole('searchbox');
const reads = (...statuses: PluginContractStatus[]) => {
  for (const status of statuses) vi.mocked(readPluginContract).mockResolvedValueOnce(status);
};
const latchedScreen = () => screen.findByTestId('update-required-screen');

beforeEach(() => {
  setWindowWidth(1280);
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  });
  storeSettings.mockReset().mockResolvedValue(pricing);
  capabilities.mockReset().mockResolvedValue({ orderCreate: 3, register: 1,
    taxRounding: { granularity: 'per_order', mode: 'half_away_from_zero' } });
  vi.mocked(readPluginContract).mockReset().mockRejectedValue(new Error('Unexpected readPluginContract call'));
  vi.mocked(fetchStoreSettings).mockResolvedValue(settings);
  vi.mocked(useSession).mockReturnValue(sessionFixture(session));
  vi.mocked(useRegister).mockReturnValue(openRegisterFixture());
  vi.mocked(useOutboxContext).mockReturnValue({ orders: {} as never, state: { pending: 0, sending: false }, recent: [], savesInFlight: 0, stuckCommandIds: [],
    record: vi.fn().mockResolvedValue(undefined), flush: vi.fn().mockResolvedValue(undefined), requeue: vi.fn().mockResolvedValue(0), discard: vi.fn(), cancelOnStore: vi.fn(), payRestOnStore: vi.fn(), reverseOnStore: vi.fn(), isStored: vi.fn().mockResolvedValue(false) });
  vi.mocked(useReplicatedProducts).mockReturnValue({ products: [shirt], state: 'synced', error: null, lastSyncedAt: null,
    stockOverlay: undefined, lastStockCheckAt: null, reconcileStock: vi.fn(async () => {}), pullNotice: undefined, resumePull: vi.fn(), syncNow: vi.fn(), clearAndRefresh: vi.fn(), unlisted: undefined });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('update required (AUDIT row 35)', () => {
  it('replaces the Sale when the store\'s plugin is too old, and Sign out signs out', async () => {
    reads('too_old');
    const signedIn = sessionFixture(session);
    vi.mocked(useSession).mockReturnValue(signedIn);
    render(<ProductsScreen />);
    const latched = await latchedScreen();
    expect(latched.textContent).toContain('https://store.test');
    expect(screen.getByText('Update required')).toBeTruthy();
    expect(screen.queryByRole('searchbox')).toBeNull();
    fireEvent.click(screen.getByTestId('update-required-sign-out'));
    expect(signedIn.signOut).toHaveBeenCalledOnce();
  });

  it.each<PluginContractStatus>(['ok', 'unknown'])('opens the POS when the read is %s', async (status) => {
    reads(status);
    render(<ProductsScreen />);
    await pos();
    expect(readPluginContract).toHaveBeenCalledExactlyOnceWith({ baseUrl: session.baseUrl, token: session.token });
    expect(screen.queryByTestId('update-required-screen')).toBeNull();
  });

  it('Check again opens the POS once the plugin is current', async () => {
    reads('too_old', 'ok');
    render(<ProductsScreen />);
    await latchedScreen();
    await act(async () => { fireEvent.click(screen.getByTestId('update-required-check-again')); });
    await pos();
    expect(screen.queryByTestId('update-required-screen')).toBeNull();
  });

  it('Check again keeps the screen and says so when the store cannot be reached', async () => {
    reads('too_old', 'unknown');
    render(<ProductsScreen />);
    await latchedScreen();
    await act(async () => { fireEvent.click(screen.getByTestId('update-required-check-again')); });
    expect(await screen.findByText('Could not reach the store. Try again in a moment.')).toBeTruthy();
    expect(screen.getByTestId('update-required-screen')).toBeTruthy();
    expect(screen.queryByRole('searchbox')).toBeNull();
  });

  it('does not read again on a token refresh for the same store', async () => {
    reads('ok');
    const view = render(<ProductsScreen />);
    await pos();
    vi.mocked(useSession).mockReturnValue(sessionFixture({ ...session, token: 'jwt-refreshed' }));
    view.rerender(<ProductsScreen />);
    await pos();
    expect(readPluginContract).toHaveBeenCalledOnce();
  });
});
