// @vitest-environment jsdom
// TallyUI 5.0.0 S3: cash taken on a sale that is not yet an order (a leg on the live cart, or on a parked sale) is in
// its session's expected cash and Z, once. A real RegisterProvider, useRegisterSession, sale screen and order store
// (memory storage); the outbox is a stand-in whose record inserts into the store.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import type { StoreSettings as PricingSettings } from '@tallyui/core';
import { createOrderBuilder, REGISTER_CLOSING, useStoreSettings, writeOrderDraft, type Payment, type PosOrder } from '@tallyui/pos';
import { PortalHost } from '@tallyui/primitives';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProductsScreen from '../app/index';
import { draftsCollection, openOrderStore, registerCollections } from '../lib/order-store';
import { useOutboxContext } from '../lib/outbox-context';
import { capabilities } from './pos-connector-mock';
import { RegisterProvider, useRegister } from '../lib/register-context';
import { saveSession } from '../lib/session';
import { SessionProvider } from '../lib/session-context';
import { fetchStoreSettings, saveCachedSettings, type StoreSettings } from '../lib/store-settings';
import { useReplicatedProducts } from '../lib/use-replicated-products';
import { openTestRegister } from './register-fixture';
import { setWindowWidth } from './window-width';
import { keyIn, pickMethod, take } from './tender-pane';

vi.mock('../lib/pos-connector', async (importOriginal) => (await import('./pos-connector-mock')).mockPosConnector(importOriginal));
vi.mock('expo-router', () => ({
  usePathname: () => '/',
  Redirect: ({ href }: { href: string }) => <span>redirect:{href}</span>,
  router: { replace: vi.fn(), push: vi.fn() },
  Stack: { Screen: ({ options }: { options: { headerRight?: () => ReactNode } }) => options.headerRight?.() },
}));
vi.mock('expo-localization', () => ({ getCalendars: () => [{ uses24hourClock: null }], getLocales: () => [{ languageTag: 'en-GB' }] }));
vi.mock('../lib/use-replicated-products', () => ({ useReplicatedProducts: vi.fn() }));
vi.mock('../lib/outbox-context', () => ({ useOutboxContext: vi.fn() }));
vi.mock('@tallyui/pos', async (importOriginal) => ({ ...await importOriginal<typeof import('@tallyui/pos')>(), useStoreSettings: vi.fn() }));
vi.mock('../lib/store-settings', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/store-settings')>(), fetchStoreSettings: vi.fn(),
}));

const settings: StoreSettings = { storeName: 'Test shop', currency: 'EUR', location: { id: 'loc', name: 'Main', countryCode: 'dk' } };
// Shirt: 12.00 + 25% tax = 15.00.
const pricing: PricingSettings = { currency: 'EUR', pricesIncludeTax: false, taxRatesPpm: { default: 250000 } };
const shirt = { id: 'shirt', title: 'Shirt', status: 'published',
  variants: [{ id: 'blue', title: 'Blue', sku: 'BLUE', prices: [{ amount: 12, currency_code: 'eur' }] }] };
const button = (name: string | RegExp) => screen.getByRole('button', { name });

let sequence = 0;
let baseUrl: string;
let store: Awaited<ReturnType<typeof openOrderStore>>;
let record: ReturnType<typeof vi.fn<(order: PosOrder) => Promise<void>>>;

beforeEach(async () => {
  setWindowWidth(1280, 800);
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  });
  baseUrl = `https://live-sale-${++sequence}.test`;
  saveCachedSettings(localStorage, baseUrl, settings);
  saveSession(localStorage, { baseUrl, email: 'admin@store.test',
    token: `header.${btoa(JSON.stringify({ exp: Date.now() / 1000 + 86400 }))}.signature` });
  capabilities.mockResolvedValue(undefined);
  vi.mocked(fetchStoreSettings).mockResolvedValue(settings);
  vi.mocked(useStoreSettings).mockReturnValue({ state: 'ready', settings: pricing, refresh: () => {} });
  vi.mocked(useReplicatedProducts).mockReturnValue({ products: [shirt], state: 'synced', error: null, lastSyncedAt: null,
    stockOverlay: undefined, lastStockCheckAt: null, reconcileStock: vi.fn(async () => {}), pullNotice: undefined, resumePull: vi.fn(), syncNow: vi.fn(), clearAndRefresh: vi.fn(), unlisted: undefined });
  store = await openOrderStore(baseUrl);
  record = vi.fn(async (order: PosOrder) => { await store.orders.insert(order); });
  vi.mocked(useOutboxContext).mockReturnValue({ orders: store.orders, state: { pending: 0, sending: false }, recent: [], savesInFlight: 0, stuckCommandIds: [],
    record, flush: vi.fn().mockResolvedValue(undefined), requeue: vi.fn().mockResolvedValue(0), discard: vi.fn(), cancelOnStore: vi.fn(), payRestOnStore: vi.fn(), reverseOnStore: vi.fn(), isStored: vi.fn().mockResolvedValue(false) });
});
/** Every held write's release, run before the store closes even when a test failed (a held closure write keeps
 *  TallyUI's module-level in-flight close stuck for later tests). */
const holds: (() => void)[] = [];
afterEach(async () => {
  for (const release of holds.splice(0)) release();
  await act(async () => { for (let turn = 0; turn < 2; turn++) await new Promise((resolve) => setTimeout(resolve, 0)); });
  cleanup();
  await store.close();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/** The provider's own value, for the rows the screen cannot reach (an unmounted screen, two registrations). */
let ctx!: ReturnType<typeof useRegister>;
function Probe() { ctx = useRegister(); return null; }
let showScreen!: (shown: boolean) => void;
function Screen({ initial }: { initial: boolean }) {
  const [shown, setShown] = useState(initial);
  showScreen = setShown;
  return shown ? <ProductsScreen /> : null;
}
async function mount(withScreen = true) {
  await act(async () => {
    render(<SessionProvider><RegisterProvider orders={store.orders} deviceId="test-device"><Probe /><Screen initial={withScreen} />
    </RegisterProvider><PortalHost /></SessionProvider>);
  });
}
async function openPanel() {
  fireEvent.click(await screen.findByRole('button', { name: 'Open register panel' }));
  fireEvent.click(await screen.findByTestId('user-sheet-register'));
  return within(await screen.findByTestId('register-panel'));
}
/** The panel's expected cash, read with the panel open, then the panel dismissed. */
async function expectedCash(amount: string) {
  const panel = await openPanel();
  // The heading, the cash row's label (empty in this environment), then the amount.
  await waitFor(() => expect(panel.getByTestId('register-panel-expected').textContent!.replace(/^Expected in the drawer(Cash)?/, '')).toBe(amount));
  return panel;
}
const dismiss = async (panel: ReturnType<typeof within>) => {
  await act(async () => { fireEvent.click(panel.getByTestId('register-panel-dismiss')); });
  await waitFor(() => expect(screen.queryByTestId('register-panel')).toBeNull());
};
/** Close register through the panel and the count, counting `cash`; resolves to the written Z. */
async function closeCounting(cash: string) {
  const panel = await openPanel();
  await act(async () => { fireEvent.click(panel.getByTestId('register-panel-close')); });
  const count = within(await screen.findByTestId('register-count'));
  fireEvent.change(count.getByTestId('count-amount'), { target: { value: cash } });
  await act(async () => { fireEvent.click(count.getByTestId('count-close')); });
  await screen.findByTestId('closure-sheet');
  return onlyClosure();
}
const closures = async () => (await registerCollections(store.orders).closures.find().exec()).map((doc) => doc.toJSON());
async function onlyClosure() {
  const all = await closures();
  expect(all).toHaveLength(1);
  return all[0];
}
const drafts = () => draftsCollection(store.orders)!;
const draftCount = async () => (await drafts().find().exec()).length;
const checkout = async () => { await act(async () => { fireEvent.click(await screen.findByTestId('cart-checkout')); }); };
const escape = async () => { await act(async () => { fireEvent.keyDown(document.body, { key: 'Escape' }); }); };
/** L1's state: Shirt (15.00) on the cart, 5.00 cash taken, the tender cancelled with the leg kept (index.tsx's Escape). */
async function cashLegOnCart(method: 'cash' | 'external' = 'cash') {
  fireEvent.click(await screen.findByTestId('product-tile-Shirt'));
  await checkout();
  pickMethod(method);
  keyIn('5.00');
  take();
  await escape();
  await waitFor(() => expect(screen.queryByTestId('tender-pane')).toBeNull());
  expect(button('Edit quantity of Shirt')).toBeTruthy();
}
/** A parked sale in the app's own shape (TallyUI's writeOrderDraft over its drafts collection): Shirt, with a cash leg. */
async function parkWithLeg(sessionId: string, amountMinor: number) {
  const builder = createOrderBuilder({ currency: 'EUR', taxContext: { pricesIncludeTax: false, getTaxRatePpm: () => 250000 } });
  builder.addLine({ productId: 'shirt', variantId: 'blue', name: 'Shirt', unitPrice: { amount: 1200, currency: 'EUR' } });
  builder.addPayment({ method: 'cash', amountMinor, status: 'captured', takenAt: new Date().toISOString(), sessionId });
  let id = '';
  await act(async () => { id = await writeOrderDraft(drafts(), builder.getSnapshot()); });
  return id;
}

describe('the live sale in the register (TallyUI 5.0.0 S3)', () => {
  it('L1: a cash leg kept on the live cart after a cancelled tender is in expected cash and the Z', async () => {
    await openTestRegister(store.orders, baseUrl);
    await mount();
    await cashLegOnCart();
    await dismiss(await expectedCash('€105.00'));
    const closure = await closeCounting('105.00');
    expect(closure).toMatchObject({ expected: { cash: 10500 }, counted: { cash: 10500 }, variance: { cash: 0 } });
  });

  it('L2: that sale completed and stored counts its cash once, the stored order\'s', async () => {
    await openTestRegister(store.orders, baseUrl);
    await mount();
    await cashLegOnCart();
    await checkout();
    pickMethod('external');
    take();
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Complete sale' })); });
    expect(record).toHaveBeenCalledOnce();
    await act(async () => { fireEvent.click(button('New sale')); });
    await dismiss(await expectedCash('€105.00'));
    expect(await closeCounting('105.00')).toMatchObject({ expected: { cash: 10500 } });
  });

  it('L3: a parked sale holding a taken cash leg counts it once, in expected cash and the Z', async () => {
    const session = await openTestRegister(store.orders, baseUrl);
    await mount();
    // The UI refuses to park a partly paid sale (use-sale.ts switchSale: SALE_PARTLY_PAID), so the draft is written directly.
    await cashLegOnCart();
    await act(async () => { fireEvent.click(screen.getByTestId('new-sale-tab')); });
    expect(await screen.findByTestId('open-sale-refusal')).toBeTruthy();
    expect(await draftCount()).toBe(0);
    await escapeCart();
    await parkWithLeg(session.id, 700);
    await dismiss(await expectedCash('€107.00'));
    expect(await closeCounting('107.00')).toMatchObject({ expected: { cash: 10700 } });
  });

  it('L4: a parked sale\'s leg and another on the live cart count once each', async () => {
    const session = await openTestRegister(store.orders, baseUrl);
    await mount();
    await parkWithLeg(session.id, 700);
    await cashLegOnCart();
    await dismiss(await expectedCash('€112.00'));
    expect(await closeCounting('112.00')).toMatchObject({ expected: { cash: 11200 } });
  });

  it('L5: the parked sale resumed onto the live cart counts once, not twice', async () => {
    const session = await openTestRegister(store.orders, baseUrl);
    await mount();
    const id = await parkWithLeg(session.id, 700);
    await act(async () => { fireEvent.click(await screen.findByTestId(`open-sale-tab-${id}`)); });
    await waitFor(async () => expect(await draftCount()).toBe(0));
    expect(button('Edit quantity of Shirt')).toBeTruthy();
    await dismiss(await expectedCash('€107.00'));
    expect(await closeCounting('107.00')).toMatchObject({ expected: { cash: 10700 } });
  });

  it('L6: a parked leg of another session is not in this session\'s expected cash or Z', async () => {
    await openTestRegister(store.orders, baseUrl);
    await mount();
    await parkWithLeg('an-earlier-session', 700);
    await dismiss(await expectedCash('€100.00'));
    expect(await closeCounting('100.00')).toMatchObject({ expected: { cash: 10000 } });
  });

  it('L7: a card leg kept on the live cart is not in expected cash; it is in its own method\'s figure', async () => {
    await openTestRegister(store.orders, baseUrl);
    await mount();
    await cashLegOnCart('external');
    const panel = await expectedCash('€100.00');
    expect(panel.getByTestId('register-panel-other-tenders').textContent).toContain('€5.00');
    await dismiss(panel);
    const closure = await closeCounting('100.00');
    expect(closure.expected.cash).toBe(10000);
    expect(Object.values(closure.expected).reduce((sum, minor) => sum + minor, 0)).toBe(10500);
  });

  it('L8: voiding the live leg after cancelling brings expected cash back to the float', async () => {
    await openTestRegister(store.orders, baseUrl);
    await mount();
    await cashLegOnCart();
    await dismiss(await expectedCash('€105.00'));
    await checkout();
    const voids = screen.getAllByTestId(/^tender-leg-.*-void$/);
    expect(voids).toHaveLength(1);
    await act(async () => { fireEvent.click(voids[0]); });
    await escape();
    await waitFor(() => expect(screen.queryByTestId('tender-pane')).toBeNull());
    await dismiss(await expectedCash('€100.00'));
    expect(await closeCounting('100.00')).toMatchObject({ expected: { cash: 10000 } });
  });
});

describe('a close while a sale saves', () => {
  it('L9: refused with the register\'s own text while a sale\'s record never settles', async () => {
    const session = await openTestRegister(store.orders, baseUrl);
    record.mockImplementationOnce(() => new Promise(() => {}));
    await mount();
    fireEvent.click(await screen.findByTestId('product-tile-Shirt'));
    await checkout();
    take();
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Complete sale' })); });
    expect(record).toHaveBeenCalledOnce();
    const panel = await openPanel();
    await act(async () => { fireEvent.click(panel.getByTestId('register-panel-close')); });
    expect(await screen.findByText(/Finish or cancel the sale in progress first\.|A sale is still being saved\./)).toBeTruthy();
    expect(screen.queryByTestId('register-count')).toBeNull();
    expect((await registerCollections(store.orders).sessions.findOne(session.id).exec())!.status).toBe('open');
    expect(await closures()).toEqual([]);
  });

  it('L9: a park in flight (useSale `saving`, the cart stage) refuses the close with RegisterSaleSavingError\'s text', async () => {
    const session = await openTestRegister(store.orders, baseUrl);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    holds.push(release);
    drafts().preInsert(async () => { await held; }, false);
    await mount();
    fireEvent.click(await screen.findByTestId('product-tile-Shirt'));
    await act(async () => { fireEvent.click(screen.getByTestId('new-sale-tab')); });
    const panel = await openPanel();
    await act(async () => { fireEvent.click(panel.getByTestId('register-panel-close')); });
    expect(await screen.findByText(/^A sale is still being saved\./)).toBeTruthy();
    expect(screen.queryByTestId('register-count')).toBeNull();
    expect((await registerCollections(store.orders).sessions.findOne(session.id).exec())!.status).toBe('open');
    await act(async () => { release(); });
    await waitFor(async () => expect(await draftCount()).toBe(1));
  });

  it('L10: the save fails, Retry succeeds; the close is then allowed and the Z counts the sale once', async () => {
    await openTestRegister(store.orders, baseUrl);
    record.mockRejectedValueOnce(new Error('Storage full'));
    await mount();
    fireEvent.click(await screen.findByTestId('product-tile-Shirt'));
    await checkout();
    take();
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Complete sale' })); });
    expect(await screen.findByText('The sale could not be saved: Storage full')).toBeTruthy();
    // While the failed save is pending, the close is refused.
    let panel = await openPanel();
    await act(async () => { fireEvent.click(panel.getByTestId('register-panel-close')); });
    expect(await screen.findByText(/Finish or cancel the sale in progress first\.|A sale is still being saved\./)).toBeTruthy();
    await dismiss(panel);
    expect(await closures()).toEqual([]);
    // Retry is Complete sale again.
    await act(async () => { fireEvent.click(button('Complete sale')); });
    expect(record).toHaveBeenCalledTimes(2);
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'New sale' })); });
    expect(await store.orders.find().exec()).toHaveLength(1);
    expect(await closeCounting('115.00')).toMatchObject({ expected: { cash: 11500 }, variance: { cash: 0 } });
  });
});

describe('the app\'s own guards', () => {
  // RegisterColumn shows the count, never the cart and its open-sale strip, while a session counts or its close is in
  // flight, so the guard's window is a close started from an open session: the app's close.run (as the column's card
  // runs it), with the session's write held, keeps the strip up while `register.closing`.
  it('L11: a switch while the register closes is refused with REGISTER_CLOSING; nothing parks; after the close it works', async () => {
    await openTestRegister(store.orders, baseUrl);
    await mount();
    fireEvent.click(await screen.findByTestId('product-tile-Shirt'));
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    holds.push(release);
    let waiting = 0;
    registerCollections(store.orders).sessions.preSave(async () => { waiting++; await held; }, false);
    let closed!: Promise<unknown>;
    act(() => { closed = ctx.close.run({ counted: { cash: 10000 } }, false); });
    await waitFor(() => expect(waiting).toBe(1));
    await waitFor(() => expect(ctx.register.closing).toBe(true));
    await act(async () => { fireEvent.click(screen.getByTestId('new-sale-tab')); });
    expect((await screen.findByTestId('open-sale-refusal')).textContent).toBe(REGISTER_CLOSING);
    expect(await draftCount()).toBe(0);
    expect(button('Edit quantity of Shirt')).toBeTruthy();
    await act(async () => { release(); await closed; });
    await act(async () => { fireEvent.click(within(await screen.findByTestId('closure-sheet')).getByTestId('closure-done')); });
    expect(await closures()).toHaveLength(1);
    await act(async () => { fireEvent.click(screen.getByTestId('new-sale-tab')); });
    await waitFor(async () => expect(await draftCount()).toBe(1));
    expect(screen.queryByTestId('open-sale-refusal')).toBeNull();
  });

  it('L12: with the sale screen unmounted, a close does not throw and its live legs read as none', async () => {
    await openTestRegister(store.orders, baseUrl);
    await mount();
    await cashLegOnCart();
    await act(async () => { showScreen(false); });
    expect(screen.queryByTestId('cart-checkout')).toBeNull();
    await act(async () => { await ctx.register.actions.closeSession({ counted: { cash: 10000 } }); });
    expect(await onlyClosure()).toMatchObject({ expected: { cash: 10000 } });
  });

  it('L13: a second registration replaces the first, and the first\'s clean-up leaves the second counting', async () => {
    const session = await openTestRegister(store.orders, baseUrl);
    await mount(false);
    await waitFor(() => expect(ctx.register.session?.id).toBe(session.id));
    const leg = (id: string, amountMinor: number): Payment => ({ id, method: 'cash', amountMinor, status: 'captured',
      takenAt: new Date().toISOString(), sessionId: session.id });
    const clearFirst = ctx.setLiveSale(() => ({ takenLegs: [leg('first', 300)], saving: false, cashRoundings: [] }));
    ctx.setLiveSale(() => ({ takenLegs: [leg('second', 900)], saving: false, cashRoundings: [] }));
    clearFirst();
    await act(async () => { await ctx.register.actions.closeSession({ counted: { cash: 10900 } }); });
    expect(await onlyClosure()).toMatchObject({ expected: { cash: 10900 }, variance: { cash: 0 } });
  });
});

/** Clears L3's refusal by taking the cart back to a fresh one: the kept leg is voided and the line removed. */
async function escapeCart() {
  await checkout();
  await act(async () => { fireEvent.click(screen.getAllByTestId(/^tender-leg-.*-void$/)[0]); });
  await escape();
  await waitFor(() => expect(screen.queryByTestId('tender-pane')).toBeNull());
  fireEvent.click(button('Edit quantity of Shirt'));
  fireEvent.click(button('Remove Shirt'));
}
