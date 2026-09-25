// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CartLineProps, CartTotalProps, ProductGrid, SearchInput } from '@tallyui/components';
import { formatMoney, SignInError, StoreSettingsError, type StoreSettings as PricingSettings, type StoreSettingsChoices } from '@tallyui/core';
import ProductsScreen from '../app/index';
import { setWindowWidth } from './window-width';
import { useOutboxContext } from '../lib/outbox-context';
import { posConnector } from '../lib/pos-connector';
import { useSession } from '../lib/session-context';
import {
  fetchStoreSettings, loadCachedPricing, loadSettingsChoice, saveCachedPricing, saveCachedSettings, saveSettingsChoice, type StoreSettings,
} from '../lib/store-settings';
import { useReplicatedProducts } from '../lib/use-replicated-products';

vi.mock('expo-router', () => ({ Redirect: () => null, router: { replace: vi.fn(), push: vi.fn() }, Stack: { Screen: () => null } }));
// expo-localization's native module isn't available under vitest.
vi.mock('expo-localization', () => ({ getCalendars: () => [{ uses24hourClock: null }] }));
vi.mock('../lib/session-context', () => ({ useSession: vi.fn() }));
vi.mock('../lib/outbox-context', () => ({ useOutboxContext: vi.fn() }));
vi.mock('../lib/use-replicated-products', () => ({ useReplicatedProducts: vi.fn() }));
vi.mock('../lib/store-settings', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/store-settings')>(), fetchStoreSettings: vi.fn(),
}));
// The real barrel fails to import under vitest (see live-tab-gate.test.tsx), so the choice screen
// and the sale components (Cart, CartBar, Tender: TallyUI TV6a) come from their own submodules, and
// the primitives Cart/Tender use internally (from '../cart', '../checkout', not the barrel) are
// mocked below by path; the rest of the POS pieces are stand-ins.
vi.mock('@tallyui/components', async () => ({
  ...await import('../node_modules/@tallyui/components/src/layout/store-settings-choice-screen'),
  ...await import('../node_modules/@tallyui/components/src/sale'),
  ProductGrid: ({ items, renderItem, emptyState }: ComponentProps<typeof ProductGrid>) =>
    <div>{items.length ? items.map((item, index) => <div key={index}>{renderItem(item, index)}</div>) : emptyState}</div>,
  ProductImage: () => null,
  ProductTitle: ({ doc }: { doc: { title?: ReactNode } }) => <span>{doc.title}</span>,
  ProductPrice: () => null,
  ProductStockBadge: () => null,
  VStack: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SearchInput: ({ placeholder }: ComponentProps<typeof SearchInput>) => <input placeholder={placeholder} />,
}));
vi.mock('../node_modules/@tallyui/components/src/cart', () => ({
  CartPanel: <T,>({ items, renderItem, emptyState, afterItems, footer }:
    { items: T[]; renderItem: (item: T, index: number) => ReactNode; emptyState?: ReactNode; afterItems?: ReactNode; footer?: ReactNode }) => <div>
    {items.length ? items.map((item, index) => <div key={index}>{renderItem(item, index)}</div>) : emptyState}
    {afterItems}{footer}
  </div>,
  CartLine: ({ name, quantity, lineTotal }: CartLineProps) => <div>{name} × {quantity} = {formatMoney(lineTotal)}</div>,
  CartTotal: ({ total }: CartTotalProps) => <span>Total: {formatMoney(total)}</span>,
  CartLineActions: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DiscountBadge: () => null,
}));
vi.mock('../node_modules/@tallyui/components/src/checkout', () => ({
  CashTendered: () => null,
  ChangeDisplay: () => null,
}));

const session = { baseUrl: 'https://store.test', email: 'cashier@store.test', token: 'jwt' };
const settings: StoreSettings = {
  storeName: 'Test shop', currency: 'EUR', location: { id: 'loc', name: 'Copenhagen', countryCode: 'dk' },
};
const pricing: PricingSettings = {
  currency: 'EUR', pricesIncludeTax: false, taxRatesPpm: { default: 250000 },
  pricingContext: { region_id: 'reg_eu', currency_code: 'eur', publishable_key: 'pk_1' },
};
const regions = [{ id: 'reg_eu', name: 'Europe' }, { id: 'reg_de', name: 'Germany' }];
const channels = [{ id: 'pk_1', name: 'Shop' }, { id: 'pk_2', name: 'Web' }];
const shirt = { id: 'shirt', title: 'Shirt', status: 'published',
  variants: [{ id: 'blue', title: 'Blue', sku: 'BLUE', prices: [{ amount: 12, currency_code: 'eur' }] }] };
const choiceRequired = (choices: StoreSettingsChoices) => new StoreSettingsError('choice_required', 'Choose', choices);
const storeSettings = vi.spyOn(posConnector, 'storeSettings');
const capabilities = vi.spyOn(posConnector, 'capabilities');
const signedIn = () => ({ session, signIn: vi.fn(), signOut: vi.fn(), reportUnauthorized: vi.fn(), mergeCapabilities: vi.fn() });
const button = (name: string) => screen.getByRole('button', { name });
const pos = () => screen.findByPlaceholderText('Search or scan barcode / SKU');

beforeEach(() => {
  setWindowWidth(1280);
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  });
  // Each test states the calls it expects; any other call fails instead of reaching the network.
  storeSettings.mockReset().mockRejectedValue(new Error('Unexpected storeSettings call'));
  capabilities.mockReset().mockResolvedValue(undefined);
  vi.mocked(fetchStoreSettings).mockResolvedValue(settings);
  vi.mocked(useSession).mockReturnValue(signedIn());
  vi.mocked(useOutboxContext).mockReturnValue({ orders: null, state: { pending: 0, sending: false }, recent: [],
    record: vi.fn().mockResolvedValue(undefined), flush: vi.fn().mockResolvedValue(undefined), requeue: vi.fn().mockResolvedValue(0) });
  vi.mocked(useReplicatedProducts).mockReturnValue({ products: [shirt], state: 'synced', error: null, lastSyncedAt: null,
    stockOverlay: undefined, lastStockCheckAt: null, reconcileStock: vi.fn(async () => {}), unlisted: undefined });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('store settings flow', () => {
  it('always resolves with the stock location\'s country, with or without a stored choice (D1)', async () => {
    storeSettings.mockResolvedValue(pricing);
    const first = render(<ProductsScreen />);
    await pos();
    expect(storeSettings).toHaveBeenLastCalledWith(expect.objectContaining({ baseUrl: session.baseUrl }), { country: 'dk' });
    first.unmount();
    localStorage.setItem(`medusapos.settings-choice.${session.baseUrl}`, JSON.stringify({ region: 'reg_eu', channel: 'pk_1', country: 'de' }));
    render(<ProductsScreen />);
    await pos();
    expect(storeSettings).toHaveBeenLastCalledWith(expect.anything(), { region: 'reg_eu', channel: 'pk_1', country: 'dk' });
  });

  it('replicates with the pricing context, and persists ready settings for an offline start (D3)', async () => {
    storeSettings.mockResolvedValue(pricing);
    render(<ProductsScreen />);
    await pos();
    const context = vi.mocked(useReplicatedProducts).mock.lastCall![1];
    expect(context).toMatchObject({ connectorId: posConnector.id, baseUrl: session.baseUrl, pricingContext: pricing.pricingContext });
    expect({ ...context.headers }).toEqual({ Authorization: 'Bearer jwt' });
    expect(loadCachedPricing(localStorage, session.baseUrl)).toEqual(pricing);
  });

  it('shows the choice screen for regions, persists the pick with the location\'s country, and opens the POS', async () => {
    storeSettings.mockRejectedValueOnce(choiceRequired({ regions })).mockResolvedValueOnce(pricing);
    render(<ProductsScreen />);
    expect(await screen.findByText('Set up this till')).toBeTruthy();
    expect(screen.queryByText('Country')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'Europe' }));
    await act(async () => { fireEvent.click(screen.getByText('Continue')); });
    await pos();
    expect(storeSettings).toHaveBeenLastCalledWith(expect.anything(), { region: 'reg_eu', country: 'dk' });
    expect(loadSettingsChoice(localStorage, session.baseUrl)).toEqual({ region: 'reg_eu' });
  });

  it('asks only for the channel when that is the only ambiguity, never for a country', async () => {
    storeSettings.mockRejectedValueOnce(choiceRequired({ countries: ['dk', 'de'], channels })).mockResolvedValueOnce(pricing);
    render(<ProductsScreen />);
    expect(await screen.findByText('Set up this till')).toBeTruthy();
    expect(screen.queryByText('Country')).toBeNull();
    expect(screen.queryByRole('radio', { name: 'Denmark' })).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'Web' }));
    await act(async () => { fireEvent.click(screen.getByText('Continue')); });
    await pos();
    expect(storeSettings).toHaveBeenLastCalledWith(expect.anything(), { channel: 'pk_2', country: 'dk' });
    expect(loadSettingsChoice(localStorage, session.baseUrl)).toEqual({ channel: 'pk_2' });
  });

  it('reports a region that does not cover the location\'s country, and "Choose another region" offers the regions again', async () => {
    storeSettings.mockRejectedValueOnce(choiceRequired({ regions }))
      .mockRejectedValueOnce(choiceRequired({ countries: ['de'], channels }))
      .mockRejectedValueOnce(choiceRequired({ regions }));
    saveSettingsChoice(localStorage, session.baseUrl, { channel: 'pk_1' });
    render(<ProductsScreen />);
    fireEvent.click(await screen.findByRole('radio', { name: 'Germany' }));
    await act(async () => { fireEvent.click(screen.getByText('Continue')); });
    expect(await screen.findByText('Stock location Copenhagen is in DK, which region Germany does not cover.')).toBeTruthy();
    expect(screen.queryByText('Set up this till')).toBeNull();
    expect(screen.queryByRole('radio')).toBeNull();
    await act(async () => { fireEvent.click(button('Choose another region')); });
    expect(await screen.findByText('Set up this till')).toBeTruthy();
    expect(storeSettings).toHaveBeenLastCalledWith(expect.anything(), { channel: 'pk_1', country: 'dk' });
  });

  it('clears a stored region the location is outside of, named by its id when the app never saw its name', async () => {
    saveSettingsChoice(localStorage, session.baseUrl, { region: 'reg_de', channel: 'pk_1' });
    storeSettings.mockRejectedValueOnce(choiceRequired({ countries: ['de'], channels })).mockResolvedValueOnce(pricing);
    render(<ProductsScreen />);
    expect(await screen.findByText('Stock location Copenhagen is in DK, which region reg_de does not cover.')).toBeTruthy();
    await act(async () => { fireEvent.click(button('Choose another region')); });
    expect(loadSettingsChoice(localStorage, session.baseUrl)).toEqual({ channel: 'pk_1' });
    await pos();
  });

  it('offers only Retry when the store\'s default region does not cover the location\'s country', async () => {
    storeSettings.mockRejectedValueOnce(choiceRequired({ countries: ['de'], channels })).mockResolvedValueOnce(pricing);
    render(<ProductsScreen />);
    expect(await screen.findByText('Stock location Copenhagen is in DK, which the store\'s default region does not cover.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Choose another region' })).toBeNull();
    await act(async () => { fireEvent.click(button('Retry')); });
    await pos();
    expect(storeSettings).toHaveBeenCalledTimes(2);
  });

  it('shows the error with Retry when there is no cached pricing', async () => {
    storeSettings.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(pricing);
    render(<ProductsScreen />);
    expect(await screen.findByText('Failed to fetch')).toBeTruthy();
    expect(screen.queryByPlaceholderText('Search or scan barcode / SKU')).toBeNull();
    await act(async () => { fireEvent.click(button('Retry')); });
    await pos();
  });

  it('opens the POS offline on cached pricing with the Offline note', async () => {
    saveCachedPricing(localStorage, session.baseUrl, pricing);
    storeSettings.mockRejectedValue(new TypeError('Failed to fetch'));
    render(<ProductsScreen />);
    await pos();
    expect(await screen.findByText('Offline')).toBeTruthy();
    expect(button('Retry')).toBeTruthy();
    expect(vi.mocked(useReplicatedProducts).mock.lastCall![1].pricingContext).toEqual(pricing.pricingContext);
  });

  it('keeps a sale in progress through an offline Retry that fails and one that succeeds (a money rule)', async () => {
    saveCachedPricing(localStorage, session.baseUrl, pricing);
    let settle!: { resolve: (value: PricingSettings) => void; reject: (error: unknown) => void };
    storeSettings.mockImplementation(() => new Promise((resolve, reject) => { settle = { resolve, reject }; }));
    const requested = (times: number) => vi.waitFor(() => expect(storeSettings).toHaveBeenCalledTimes(times));
    render(<ProductsScreen />);
    await requested(1);
    await act(async () => { settle.reject(new TypeError('Failed to fetch')); });
    await pos();
    const startSale = () => { fireEvent.click(button('Shirt')); fireEvent.click(button('Card terminal')); };
    const inTender = () => {
      expect(screen.getByText('Card terminal: €15.00')).toBeTruthy();
      expect(button('Payment approved on terminal')).toBeTruthy();
    };
    const toIdle = () => { fireEvent.click(button('Back')); fireEvent.click(button('Remove Shirt')); };
    const replicationContext = vi.mocked(useReplicatedProducts).mock.lastCall![1];

    // Retry is offered only while the sale is idle, so a sale is started while the retry loads.
    await act(async () => { fireEvent.click(button('Retry')); });
    await requested(2);
    startSale();
    inTender(); // still mounted while the retry loads
    await act(async () => { settle.reject(new TypeError('Failed to fetch')); });
    inTender();
    expect(screen.getByText('Offline')).toBeTruthy();

    toIdle();
    await act(async () => { fireEvent.click(button('Retry')); });
    await requested(3);
    startSale();
    await act(async () => { settle.resolve({ ...pricing, taxRatesPpm: { ...pricing.taxRatesPpm } }); });
    inTender();
    expect(screen.queryByText('Offline')).toBeNull();
    expect(vi.mocked(useReplicatedProducts).mock.lastCall![1]).toBe(replicationContext);
    fireEvent.click(button('Back'));
    expect(button('Remove Shirt')).toBeTruthy();
    expect(screen.getByText('Total: €15.00')).toBeTruthy();
  }, 20000);

  it('hides Retry while the cart has lines or a tender is open, and new settings wait for the sale to end (a money rule)', async () => {
    saveCachedPricing(localStorage, session.baseUrl, pricing);
    let settle!: { resolve: (value: PricingSettings) => void; reject: (error: unknown) => void };
    storeSettings.mockImplementation(() => new Promise((resolve, reject) => { settle = { resolve, reject }; }));
    render(<ProductsScreen />);
    await vi.waitFor(() => expect(storeSettings).toHaveBeenCalledOnce());
    await act(async () => { settle.reject(new TypeError('Failed to fetch')); });
    await pos();
    expect(button('Retry')).toBeTruthy();
    fireEvent.click(button('Shirt'));
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    fireEvent.click(button('Card terminal'));
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    fireEvent.click(button('Back'));
    fireEvent.click(button('Remove Shirt'));
    await act(async () => { fireEvent.click(button('Retry')); });
    await vi.waitFor(() => expect(storeSettings).toHaveBeenCalledTimes(2));
    // The catalogue follows the replication context's region: Germany's own Shirt price is €20.
    const shirtDe = { ...shirt, variants: [{ ...shirt.variants[0], prices: [{ amount: 20, currency_code: 'eur' }] }] };
    vi.mocked(useReplicatedProducts).mockImplementation((_connector, context) => ({ products: [context.pricingContext?.region_id === 'reg_de' ? shirtDe : shirt],
      state: 'synced', error: null, lastSyncedAt: null, stockOverlay: undefined, lastStockCheckAt: null, reconcileStock: vi.fn(async () => {}), unlisted: undefined }));
    const region = () => vi.mocked(useReplicatedProducts).mock.lastCall![1].pricingContext?.region_id;
    fireEvent.click(button('Shirt'));
    // Germany's settings (19% inclusive, its own prices) arrive mid-sale: the sale, and the catalogue, stay on Europe's.
    await act(async () => { settle.resolve({ currency: 'EUR', pricesIncludeTax: true, taxRatesPpm: { default: 190000 },
      pricingContext: { region_id: 'reg_de', currency_code: 'eur', publishable_key: 'pk_1' } }); });
    expect(region()).toBe('reg_eu');
    fireEvent.click(button('Shirt'));
    expect(screen.getByText('Total: €30.00')).toBeTruthy();
    fireEvent.click(button('Card terminal'));
    expect(screen.getByText('Card terminal: €30.00')).toBeTruthy();
    await act(async () => { fireEvent.click(button('Payment approved on terminal')); });
    const record = vi.mocked(useOutboxContext().record);
    expect(record).toHaveBeenCalledOnce();
    expect(record.mock.calls[0][0]).toMatchObject({ pricesIncludeTax: false, subtotalMinor: 2400, taxMinor: 600, totalMinor: 3000,
      lines: [expect.objectContaining({ quantity: 2, unitPriceMinor: 1200 })],
      payments: [expect.objectContaining({ method: 'external', amountMinor: 3000 })] });
    expect(region()).toBe('reg_eu');
    await act(async () => { fireEvent.click(button('New sale')); });
    expect(region()).toBe('reg_de');
    fireEvent.click(button('Shirt'));
    expect(screen.getByText('Total: €20.00')).toBeTruthy();
  }, 20000);

  it('keeps the POS and its sale when a retry resolves to the choice screen mid-sale, and shows the choice after it (a money rule)', async () => {
    saveCachedPricing(localStorage, session.baseUrl, pricing);
    let settle!: { resolve: (value: PricingSettings) => void; reject: (error: unknown) => void };
    storeSettings.mockImplementation(() => new Promise((resolve, reject) => { settle = { resolve, reject }; }));
    render(<ProductsScreen />);
    await vi.waitFor(() => expect(storeSettings).toHaveBeenCalledOnce());
    await act(async () => { settle.reject(new TypeError('Failed to fetch')); });
    await pos();
    await act(async () => { fireEvent.click(button('Retry')); });
    await vi.waitFor(() => expect(storeSettings).toHaveBeenCalledTimes(2));
    fireEvent.click(button('Shirt'));
    fireEvent.click(button('Card terminal'));
    await act(async () => { settle.reject(choiceRequired({ regions })); });
    expect(screen.queryByText('Set up this till')).toBeNull();
    expect(screen.getByText('Card terminal: €15.00')).toBeTruthy();
    // A held choose result is not an outage: the status says the change waits for the sale, never "Offline".
    expect(screen.getByText('Store settings changed; this applies after the current sale')).toBeTruthy();
    expect(screen.queryByText('Offline')).toBeNull();
    await act(async () => { fireEvent.click(button('Payment approved on terminal')); });
    expect(vi.mocked(useOutboxContext().record).mock.calls[0][0]).toMatchObject({ totalMinor: 1500, taxMinor: 300 });
    expect(screen.queryByText('Set up this till')).toBeNull();
    await act(async () => { fireEvent.click(button('New sale')); });
    expect(await screen.findByText('Set up this till')).toBeTruthy();
  }, 20000);

  it('resolves again when the stock location\'s country changes (D1)', async () => {
    saveCachedSettings(localStorage, session.baseUrl, settings);
    let fetched!: (value: StoreSettings) => void;
    vi.mocked(fetchStoreSettings).mockReturnValue(new Promise((resolve) => { fetched = resolve; }));
    storeSettings.mockResolvedValue(pricing);
    render(<ProductsScreen />);
    await pos();
    expect(storeSettings.mock.calls.map((call) => call[1])).toEqual([{ country: 'dk' }]);
    await act(async () => { fetched({ ...settings, location: { ...settings.location, countryCode: 'de' } }); });
    await vi.waitFor(() => expect(storeSettings.mock.calls.map((call) => call[1])).toEqual([{ country: 'dk' }, { country: 'de' }]));
    await pos();
  });

  it('keeps the sync context and its capabilities through a token refresh, without re-resolving, and sends the new token', async () => {
    storeSettings.mockResolvedValue(pricing);
    const handlers = signedIn();
    vi.mocked(useSession).mockReturnValue({ ...handlers, session: { ...session, capabilities: { orderCreate: 2 } } });
    const view = render(<ProductsScreen />);
    await pos();
    const context = vi.mocked(useReplicatedProducts).mock.lastCall![1];
    expect(context.capabilities).toEqual({ orderCreate: 2 });
    vi.mocked(useSession).mockReturnValue({ ...handlers, session: { ...session, token: 'jwt-refreshed', capabilities: { orderCreate: 2 } } });
    await act(async () => { view.rerender(<ProductsScreen />); });
    await pos();
    expect(storeSettings).toHaveBeenCalledOnce();
    expect(vi.mocked(useReplicatedProducts).mock.lastCall![1]).toBe(context);
    expect(context.headers.Authorization).toBe('Bearer jwt-refreshed');
    expect(storeSettings.mock.calls[0][0].headers.Authorization).toBe('Bearer jwt-refreshed');
    // The restored session's capability read ran once, with the token it opened with.
    expect(capabilities).toHaveBeenCalledOnce();
    expect(capabilities.mock.calls[0][0]).toMatchObject({ baseUrl: session.baseUrl, headers: { Authorization: 'Bearer jwt' } });
  });

  it.each([
    [{ orderCreate: 2 }, 'mergeCapabilities'], [undefined, 'mergeCapabilities'], [new SignInError('invalid_credentials', '401'), 'reportUnauthorized'],
  ] as const)('passes the restored session\'s capability read %s to %s', async (read, handler) => {
    if (read instanceof Error) capabilities.mockRejectedValue(read);
    else capabilities.mockResolvedValue(read);
    storeSettings.mockResolvedValue(pricing);
    render(<ProductsScreen />);
    await pos();
    const context = useSession();
    await vi.waitFor(() => expect(context[handler]).toHaveBeenCalledOnce());
    if (handler === 'mergeCapabilities') expect(context.mergeCapabilities).toHaveBeenCalledWith(read);
    else expect(context.mergeCapabilities).not.toHaveBeenCalled();
  });
});
