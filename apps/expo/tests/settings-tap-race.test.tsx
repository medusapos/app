// @vitest-environment jsdom
// The tap race when new store settings land (#58 review, TallyUI/tallyui#301): a line added at the instant new store settings
// land must stay in the cart. The real useSale (@tallyui/pos) and the real ProductsScreen, as the app runs them.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useEffect, useLayoutEffect, type ComponentProps, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CartLineProps, CartTotalProps, ProductGrid, SearchInput } from '@tallyui/components';
import { formatMoney, type StoreSettings as PricingSettings } from '@tallyui/core';
import ProductsScreen from '../app/index';
import { setWindowWidth } from './window-width';
import { useOutboxContext } from '../lib/outbox-context';
import { capabilities, storeSettings } from './pos-connector-mock';
import { useSession } from '../lib/session-context';
import { fetchStoreSettings, saveCachedPricing, type StoreSettings } from '../lib/store-settings';
import { useReplicatedProducts } from '../lib/use-replicated-products';
import { useRegister } from '../lib/register-context';
import { openRegisterFixture } from './register-fixture';

vi.mock('../lib/pos-connector', async (importOriginal) => (await import('./pos-connector-mock')).mockPosConnector(importOriginal));
vi.mock('expo-router', () => ({ Redirect: () => null, router: { replace: vi.fn(), push: vi.fn() }, Stack: { Screen: () => null } }));
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
vi.mock('@tallyui/components/product', () => ({
  ProductGrid: ({ items, renderItem, emptyState }: ComponentProps<typeof ProductGrid>) =>
    <div>{items.length ? items.map((item, index) => <div key={index}>{renderItem(item, index)}</div>) : emptyState}</div>,
  ProductImage: () => null,
  ProductTitle: ({ doc }: { doc: { title?: ReactNode } }) => <span>{doc.title}</span>,
  ProductPrice: () => null,
  ProductStockBadge: () => null,
}));
vi.mock('@tallyui/components/ui', () => ({ VStack: ({ children }: { children?: ReactNode }) => <div>{children}</div> }));
vi.mock('@tallyui/components/input', () => ({
  SearchInput: ({ placeholder }: ComponentProps<typeof SearchInput>) => <input placeholder={placeholder} />,
}));
vi.mock('@tallyui/components/cart', () => ({
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
vi.mock('@tallyui/components/checkout', () => ({ CashTendered: () => null, ChangeDisplay: () => null }));

const session = { baseUrl: 'https://store.test', email: 'cashier@store.test', token: 'jwt' };
const settings: StoreSettings = { storeName: 'Test shop', currency: 'EUR', location: { id: 'loc', name: 'Copenhagen', countryCode: 'dk' } };
// Europe, 25% exclusive: the cached pricing the till starts on (offline).
const europe: PricingSettings = {
  currency: 'EUR', pricesIncludeTax: false, taxRatesPpm: { default: 250000 },
  pricingContext: { region_id: 'reg_eu', currency_code: 'eur', publishable_key: 'pk_1' },
};
// Germany, 19% inclusive: the new settings a Retry resolves to (a different tax context).
const germany: PricingSettings = {
  currency: 'EUR', pricesIncludeTax: true, taxRatesPpm: { default: 190000 },
  pricingContext: { region_id: 'reg_de', currency_code: 'eur', publishable_key: 'pk_1' },
};
// The catalogue follows the replication context's region: Shirt €12 and Hat €10 in Europe, €20 and €30 in Germany.
const product = (id: string, title: string, amount: number) => ({ id, title, status: 'published',
  variants: [{ id: `${id}-1`, title: 'One', sku: id.toUpperCase(), prices: [{ amount, currency_code: 'eur' }] }] });
const catalogue = (region?: string) => region === 'reg_de'
  ? [product('shirt', 'Shirt', 20), product('hat', 'Hat', 30)] : [product('shirt', 'Shirt', 12), product('hat', 'Hat', 10)];
const button = (name: string) => screen.getByRole('button', { name });
const pos = () => screen.findByPlaceholderText('Search or scan barcode / SKU');
const region = () => vi.mocked(useReplicatedProducts).mock.lastCall![1].pricingContext?.region_id;
// Outside act() React runs on its real scheduler, as in the browser: a default-priority render (settings landing
// from a fetch) commits in one task and runs its passive effects in a later one, so a tap can land between them.
const actEnvironment = (on: boolean) => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = on; };
const settleTasks = () => new Promise((resolve) => setTimeout(resolve, 100));
/** A native click, not wrapped in act(): the browser's own event, dispatched to React's root listener. */
const tap = (name: string) => { button(name).click(); };

// Probes in SignedInProducts (the replication hook is a stand-in, called as a hook there) for the POS moving onto
// Germany's settings: `onGermanyCommit` from a layout effect (during that commit, before its passive effects), and
// `onGermanyEffect` from a passive effect (in the same flush as, and just before, useSale's own effects).
let onGermanyCommit: (() => void) | null = null;
let onGermanyEffect: (() => void) | null = null;
let actEnvironmentBefore: boolean | undefined;

beforeEach(() => {
  actEnvironmentBefore = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  setWindowWidth(1280);
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  });
  onGermanyCommit = null;
  onGermanyEffect = null;
  capabilities.mockResolvedValue({ orderCreate: 3, register: 1,
    taxRounding: { granularity: 'per_order', mode: 'half_away_from_zero' } });
  vi.mocked(fetchStoreSettings).mockResolvedValue(settings);
  vi.mocked(useSession).mockReturnValue({ session, signIn: vi.fn(), signOut: vi.fn(), reportUnauthorized: vi.fn(),
    mergeCapabilities: vi.fn(), setSaleHold: vi.fn(), setSavesHold: vi.fn(), signOutDeferred: false });
  vi.mocked(useRegister).mockReturnValue(openRegisterFixture());
  vi.mocked(useOutboxContext).mockReturnValue({ orders: {} as never, state: { pending: 0, sending: false }, recent: [], savesInFlight: 0, stuckCommandIds: [],
    record: vi.fn().mockResolvedValue(undefined), flush: vi.fn().mockResolvedValue(undefined), requeue: vi.fn().mockResolvedValue(0),
    isStored: vi.fn().mockResolvedValue(false) });
  vi.mocked(useReplicatedProducts).mockImplementation((_connector, context) => {
    const id = context.pricingContext?.region_id;
    useLayoutEffect(() => { if (id === 'reg_de') onGermanyCommit?.(); }, [id]);
    useEffect(() => { if (id === 'reg_de') onGermanyEffect?.(); }, [id]);
    return { products: catalogue(id), state: 'synced', error: null, lastSyncedAt: null, stockOverlay: undefined,
      lastStockCheckAt: null, reconcileStock: vi.fn(async () => {}), pullNotice: undefined, resumePull: vi.fn(), unlisted: undefined };
  });
});
afterEach(() => {
  // The globals this file changes: the act environment (the race runs outside act()), the width and localStorage.
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = actEnvironmentBefore;
  cleanup();
  delete (document.documentElement as { clientWidth?: number }).clientWidth;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/** Opens the POS offline on Europe's cached pricing, with an empty cart and a Retry in flight; returns its settle. */
async function idleWithRetryInFlight() {
  saveCachedPricing(localStorage, session.baseUrl, europe);
  const settle: { resolve: (value: PricingSettings) => void; reject: (error: unknown) => void }[] = [];
  storeSettings.mockImplementation(() => new Promise((resolve, reject) => { settle.push({ resolve, reject }); }));
  render(<ProductsScreen />);
  await vi.waitFor(() => expect(settle).toHaveLength(1));
  await act(async () => { settle[0].reject(new TypeError('Failed to fetch')); });
  await pos();
  await act(async () => { fireEvent.click(button('Retry')); });
  await vi.waitFor(() => expect(settle).toHaveLength(2));
  expect(screen.queryByRole('button', { name: 'Remove Shirt' })).toBeNull();
  expect(region()).toBe('reg_eu');
  return settle[1];
}

/** Resolves the Retry to Germany's settings outside act(), runs `during` while React works, then lets it settle. */
async function germanyLands(retry: { resolve: (value: PricingSettings) => void }, during: () => Promise<void> | void = () => {}) {
  actEnvironment(false);
  try {
    retry.resolve(germany);
    await during();
    await settleTasks();
  } finally {
    actEnvironment(true);
  }
}

describe('tap race when new store settings land (#58 review)', () => {
  it('window 1: keeps a line tapped right after the new settings commit, before that commit\'s effects run', async () => {
    const retry = await idleWithRetryInFlight();
    let tapped = false;
    // The tap is queued behind the commit task (a microtask here), ahead of React's passive-effects task.
    onGermanyCommit = () => { if (!tapped) { tapped = true; queueMicrotask(() => tap('Shirt')); } };
    await germanyLands(retry, () => vi.waitFor(() => expect(tapped).toBe(true)));
    expect(button('Remove Shirt')).toBeTruthy();
  });

  it('window 2: keeps a line tapped after useSale\'s new-sale effect ran, before the new builder renders', async () => {
    const retry = await idleWithRetryInFlight();
    let tapped = false;
    // Queued during the passive-effects flush, so it runs once useSale's effect has called newSale() (setBuilder
    // pending), ahead of the render that would hand the new builder to the Catalogue's onSelect.
    onGermanyEffect = () => { if (!tapped) { tapped = true; queueMicrotask(() => tap('Shirt')); } };
    await germanyLands(retry, () => vi.waitFor(() => expect(tapped).toBe(true)));
    expect(button('Remove Shirt')).toBeTruthy();
  });

  it('window 1, synchronous: keeps a line tapped from inside the new settings\' commit (a layout effect)', async () => {
    const retry = await idleWithRetryInFlight();
    let tapped = false;
    onGermanyCommit = () => { if (!tapped) { tapped = true; tap('Shirt'); } };
    await germanyLands(retry, () => vi.waitFor(() => expect(tapped).toBe(true)));
    expect(button('Remove Shirt')).toBeTruthy();
  });

  it('window 0: a tap after the settings update is queued, before it renders, keeps the line and Europe\'s pricing', async () => {
    const retry = await idleWithRetryInFlight();
    // Well past the microtask that sets the store state; React renders a default-priority update only in a later
    // task, and renders the tap's update together with it (19.x renders sync and default lanes in one pass).
    await germanyLands(retry, async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); tap('Shirt'); });
    expect(button('Remove Shirt')).toBeTruthy();
    expect(screen.getByText('Total: €15.00')).toBeTruthy(); // the Shirt at Europe's €12 + 25%
    // The sale started on Europe's settings, so the catalogue stays on them too (a money rule): Hat is €10 + 25%.
    fireEvent.click(button('Hat'));
    expect(region()).toBe('reg_eu');
    expect(screen.getByText('Total: €27.50')).toBeTruthy();
  });

  it('control: keeps a line tapped in the same tick the new settings resolve (the tap first)', async () => {
    const retry = await idleWithRetryInFlight();
    await germanyLands(retry, () => tap('Shirt'));
    expect(button('Remove Shirt')).toBeTruthy();
    expect(region()).toBe('reg_eu');
    expect(screen.getByText('Total: €15.00')).toBeTruthy();
  });

  it('control: keeps a line tapped once the new settings\' effects have run, on Germany\'s pricing', async () => {
    const retry = await idleWithRetryInFlight();
    let committed = false;
    onGermanyCommit = () => { committed = true; };
    await germanyLands(retry, async () => { await vi.waitFor(() => expect(committed).toBe(true)); await settleTasks(); tap('Shirt'); });
    expect(button('Remove Shirt')).toBeTruthy();
    expect(screen.getByText('Total: €20.00')).toBeTruthy(); // Germany's €20, tax included
  });

  it('a refused add does not leave the settings hold on: the next store settings still apply', async () => {
    // A Cap priced only in USD: @tallyui/pos 2.0.0 addEntryToCart throws CartError(`No EUR price for Cap`) (sale/cart.ts:17),
    // and useSale.add catches it into `error` (sale/use-sale.ts:195-197), so the tap's onBusy(true) meets an empty cart.
    const replicated = vi.mocked(useReplicatedProducts).getMockImplementation()!;
    vi.mocked(useReplicatedProducts).mockImplementation((...args) => {
      const result = replicated(...args);
      return { ...result, products: [...result.products, { ...product('cap', 'Cap', 9),
        variants: [{ id: 'cap-1', title: 'One', sku: 'CAP', prices: [{ amount: 9, currency_code: 'usd' }] }] }] };
    });
    const retry = await idleWithRetryInFlight();
    fireEvent.click(button('Cap'));
    expect(screen.getByRole('alert').textContent).toBe('No EUR price for Cap');
    expect(screen.queryByRole('button', { name: 'Remove Cap' })).toBeNull();
    await germanyLands(retry);
    expect(region()).toBe('reg_de');
    fireEvent.click(button('Shirt'));
    expect(screen.getByText('Total: €20.00')).toBeTruthy(); // Germany's €20, tax included
  });
});
