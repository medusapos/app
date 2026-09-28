// @vitest-environment jsdom
// The register on the sale screen (ADR 0017): a real RegisterProvider, useRegisterSession and TallyUI register
// components over a real order store (memory storage); the outbox is a stand-in whose record inserts into it.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ComponentProps, ReactNode } from 'react';
import type { CartLineProps, CartTotalProps, SearchInput, ProductGrid } from '@tallyui/components';
import { formatMoney, type StoreSettings as PricingSettings } from '@tallyui/core';
import {
  bindRegister, closeSession, openSession, readRegister, startCounting, useStoreSettings, type PosOrder,
} from '@tallyui/pos';
import { APPROVAL_REQUIRED_TEXT } from '@tallyui/components';
import { PortalHost } from '@tallyui/primitives';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProductsScreen from '../app/index';
import { GETTING_READY, OPEN_TO_PAY } from '../components/register';
import { APPROVE_OFFLINE } from '../components/register-close';
import { rememberApprover } from '../lib/approval';
import { openOrderStore, registerCollections } from '../lib/order-store';
import { useOutboxContext } from '../lib/outbox-context';
import { posConnector } from '../lib/pos-connector';
import { RegisterProvider } from '../lib/register-context';
import { saveSession } from '../lib/session';
import { SessionProvider } from '../lib/session-context';
import { fetchStoreSettings, saveCachedSettings, type StoreSettings } from '../lib/store-settings';
import { useReplicatedProducts } from '../lib/use-replicated-products';
import { openTestRegister } from './register-fixture';
import { setWindowWidth } from './window-width';

vi.mock('expo-router', () => ({
  Redirect: ({ href }: { href: string }) => <span>redirect:{href}</span>,
  router: { replace: vi.fn(), push: vi.fn() },
  Stack: { Screen: ({ options }: { options: { headerRight?: () => ReactNode } }) => options.headerRight?.() },
}));
vi.mock('expo-localization', () => ({ getCalendars: () => [{ uses24hourClock: null }], getLocales: () => [{ languageTag: 'en-GB' }] }));
vi.mock('../lib/use-replicated-products', () => ({ useReplicatedProducts: vi.fn() }));
vi.mock('../lib/outbox-context', () => ({ useOutboxContext: vi.fn() }));
vi.mock('@tallyui/pos', async (importOriginal) => ({
  ...await importOriginal<typeof import('@tallyui/pos')>(), useStoreSettings: vi.fn(),
}));
vi.mock('../lib/store-settings', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/store-settings')>(), fetchStoreSettings: vi.fn(),
}));
// The sale primitives as products-screen.test.tsx stubs them; the register components are real.
vi.mock('@tallyui/components/product', () => ({
  ProductGrid: ({ items, renderItem, emptyState }: ComponentProps<typeof ProductGrid>) => (
    <div>{items.length ? items.map((item, index) => <div key={item.id}>{renderItem(item, index)}</div>) : emptyState}</div>
  ),
  ProductImage: () => null,
  ProductTitle: ({ doc }: { doc: { title?: ReactNode } }) => <span>{doc.title}</span>,
  ProductPrice: () => null,
  ProductStockBadge: () => null,
}));
// The rest of the UI kit stays real: the app's approval dialog and last-closure figures use it.
vi.mock('@tallyui/components/ui', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  VStack: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock('@tallyui/components/input', () => ({
  SearchInput: ({ value, onChangeText, onSubmitEditing, placeholder }: ComponentProps<typeof SearchInput>) => (
    <input value={value} placeholder={placeholder} onChange={(event) => onChangeText(event.target.value)}
      onKeyDown={(event) => { if (event.key === 'Enter') onSubmitEditing?.({} as never); }} />
  ),
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

const settings: StoreSettings = { storeName: 'Test shop', currency: 'EUR', location: { id: 'loc', name: 'Main', countryCode: 'dk' } };
const pricing: PricingSettings = { currency: 'EUR', pricesIncludeTax: false, taxRatesPpm: { default: 250000 } };
const shirt = { id: 'shirt', title: 'Shirt', status: 'published',
  variants: [{ id: 'blue', title: 'Blue', sku: 'BLUE', prices: [{ amount: 12, currency_code: 'eur' }] }] };
const button = (name: string | RegExp) => screen.getByRole('button', { name });
const pill = () => screen.queryByTestId('register-bar-pill')?.textContent ?? null;

let sequence = 0;
let storageData: Map<string, string>;
let baseUrl: string;
let store: Awaited<ReturnType<typeof openOrderStore>>;
let record: ReturnType<typeof vi.fn<(order: PosOrder) => Promise<void>>>;

beforeEach(async () => {
  setWindowWidth(1280);
  const data = storageData = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  });
  baseUrl = `https://register-${++sequence}.test`;
  saveCachedSettings(localStorage, baseUrl, settings);
  saveSession(localStorage, { baseUrl, email: 'admin@store.test',
    token: `header.${btoa(JSON.stringify({ exp: Date.now() / 1000 + 86400 }))}.signature` });
  vi.spyOn(posConnector, 'capabilities').mockResolvedValue(undefined);
  vi.mocked(fetchStoreSettings).mockResolvedValue(settings);
  vi.mocked(useStoreSettings).mockReturnValue({ state: 'ready', settings: pricing });
  vi.mocked(useReplicatedProducts).mockReturnValue({ products: [shirt], state: 'synced', error: null, lastSyncedAt: null,
    stockOverlay: undefined, lastStockCheckAt: null, reconcileStock: vi.fn(async () => {}), unlisted: undefined });
  store = await openOrderStore(baseUrl);
  record = vi.fn(async (order: PosOrder) => { await store.orders.insert(order); });
  vi.mocked(useOutboxContext).mockReturnValue({ orders: store.orders, state: { pending: 0, sending: false }, recent: [], savesInFlight: 0,
    record, flush: vi.fn().mockResolvedValue(undefined), requeue: vi.fn().mockResolvedValue(0), isStored: vi.fn().mockResolvedValue(false) });
});
afterEach(async () => {
  cleanup();
  await store.close();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function mount() {
  await act(async () => {
    render(<SessionProvider><RegisterProvider orders={store.orders}><ProductsScreen /></RegisterProvider><PortalHost /></SessionProvider>);
  });
}
const sessions = () => registerCollections(store.orders).sessions;
async function openPanel() {
  fireEvent.click(await screen.findByRole('button', { name: 'Open register panel' }));
  return within(await screen.findByTestId('register-panel'));
}
/** The panel's Close register: RegisterCount replaces the cart. */
async function startCount() {
  const panel = await openPanel();
  await act(async () => { fireEvent.click(panel.getByTestId('register-panel-close')); });
  return within(await screen.findByTestId('register-count'));
}
async function closeWith(count: ReturnType<typeof within>, cash: string) {
  fireEvent.change(count.getByTestId('count-amount'), { target: { value: cash } });
  await act(async () => { fireEvent.click(count.getByTestId('count-close')); });
}

describe('the register on the sale screen', () => {
  it('shows the picker while unbound; a pick binds it and shows the open card; opening with a float shows the cart and the bar', async () => {
    await mount();
    expect(await screen.findByTestId('register-picker')).toBeTruthy();
    expect(pill()).toBe('Choose a register');
    await act(async () => { fireEvent.click(screen.getByTestId('register-picker-row-register-1')); });
    expect(await screen.findByTestId('open-register-card')).toBeTruthy();
    expect(screen.queryByTestId('register-picker')).toBeNull();
    const bound = (await readRegister(sessions()))!.stores[baseUrl];
    expect([bound.register_id, bound.register_name]).toEqual(['register-1', 'Register 1']);
    await waitFor(() => expect(pill()).toBe('Register closed'));

    fireEvent.change(screen.getByTestId('open-register-amount'), { target: { value: '100.00' } });
    await act(async () => { fireEvent.click(screen.getByTestId('open-register-button')); });
    await waitFor(() => expect(screen.queryByTestId('open-register-card')).toBeNull());
    expect(screen.getByText('Scan or tap a product to start a sale.')).toBeTruthy();
    expect(screen.getByTestId('register-bar')).toBeTruthy();
    expect(pill()).toBeNull();
    expect(button('Open register panel')).toBeTruthy();
    const [row] = (await sessions().find().exec()).map((doc) => doc.toJSON());
    expect(row).toMatchObject({ register_id: 'register-1', status: 'open', counted_float_minor: 10000, opened_by: 'admin@store.test' });
  });

  it.each([['unbound', 'register-picker'], ['bound, not open', 'open-register-card']])(
    'while %s, taps and scans still add to the cart, and Cash and Card refuse above it without starting the tender',
    async (state, gate) => {
      if (state !== 'unbound') await bindRegister(sessions(), baseUrl, { id: 'register-1', name: 'Register 1' });
      await mount();
      const card = await screen.findByTestId(gate);
      fireEvent.click(button('Shirt'));
      const search = screen.getByPlaceholderText('Search or scan barcode / SKU');
      fireEvent.change(search, { target: { value: 'BLUE' } });
      fireEvent.keyDown(search, { key: 'Enter' });
      expect(screen.getByText('Shirt × 2 = €24.00')).toBeTruthy();
      for (const method of ['Cash', 'Card terminal']) {
        await act(async () => { fireEvent.click(button(method)); });
        expect(screen.getByRole('alert').textContent).toBe(OPEN_TO_PAY);
        expect(screen.queryByRole('button', { name: /Complete sale|Payment approved on terminal/ })).toBeNull();
        // Above the cart, which is still there to use.
        expect(card.compareDocumentPosition(button(method)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      }
      expect(record).not.toHaveBeenCalled();
    });

  it('stamps a completed sale with the open session, and the panel counts it', async () => {
    const session = await openTestRegister(store.orders, baseUrl);
    await mount();
    await screen.findByRole('button', { name: 'Open register panel' });
    fireEvent.click(button('Shirt'));
    await act(async () => { fireEvent.click(button('Card terminal')); });
    expect(screen.queryByRole('alert')).toBeNull();
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Payment approved on terminal' })); });
    expect(record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sessionId: session.id, totalMinor: 1500 }));
    expect(record.mock.calls[0][0]).not.toHaveProperty('lateSessionId');
    await act(async () => { fireEvent.click(button('New sale')); });
    const panel = await openPanel();
    await waitFor(() => expect(panel.getByTestId('register-panel-sales-count').textContent).toBe('1 sale this session'));
  });

  it('records a paid in of 5.00 from the panel, and Undo voids it', async () => {
    const session = await openTestRegister(store.orders, baseUrl);
    await mount();
    const panel = await openPanel();
    fireEvent.click(panel.getByTestId('register-panel-paid-in'));
    const sheet = within(await screen.findByTestId('movement-sheet'));
    fireEvent.change(sheet.getByTestId('movement-amount'), { target: { value: '5.00' } });
    fireEvent.change(sheet.getByTestId('movement-reason'), { target: { value: 'Change' } });
    await act(async () => { fireEvent.click(sheet.getByTestId('movement-confirm')); });
    await waitFor(() => expect(screen.queryByTestId('movement-sheet')).toBeNull());
    const { movements } = registerCollections(store.orders);
    const [paidIn] = (await movements.find().exec()).map((doc) => doc.toJSON());
    expect(paidIn).toMatchObject({ session_id: session.id, type: 'paid_in', amountMinor: 500, reason: 'Change', created_by: 'admin@store.test' });
    fireEvent.click(panel.getByTestId('register-panel-movements'));
    expect((await panel.findByTestId(`movement-row-${paidIn.id}`)).textContent).toBe('Paid in · €5.00 · Change');
    await act(async () => { fireEvent.click(panel.getByTestId(`movement-void-${paidIn.id}`)); });
    await waitFor(() => expect(panel.queryByTestId(`movement-row-${paidIn.id}`)).toBeNull());
    const rows = (await movements.find().exec()).map((doc) => doc.toJSON());
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.type === 'void')).toMatchObject({ voids: paidIn.id, amountMinor: 500 });
  });

  it('Close register starts counting, which shows the count until Back to selling', async () => {
    await openTestRegister(store.orders, baseUrl);
    await mount();
    await startCount();
    expect(screen.queryByRole('button', { name: 'Cash' })).toBeNull();
    await waitFor(() => expect(pill()).toBe('Counting'));
    await act(async () => { fireEvent.click(screen.getByTestId('count-back')); });
    await waitFor(() => expect(screen.queryByTestId('register-count')).toBeNull());
    expect(button('Cash')).toBeTruthy();
    expect((await sessions().find().exec())[0].status).toBe('open');
  });
});

// Registers part B (ADR 0018): the count, the closure sheet, the last closure's figures and the approval gate.
describe('closing the register', () => {
  const PASSWORD = 'manager-secret-7';
  const TOKEN = 'approver-token-xyz';
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  /** A stand-in Medusa for the approver's sign-in (emailpass, then the plugin's info: 404) and /admin/users/me. */
  function stubMedusa(signIn: () => Response = () => json({ token: TOKEN })) {
    const fetch = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path === '/auth/user/emailpass') return signIn();
      if (path === '/admin/users/me') return json({ user: { id: 'user_mgr', first_name: 'Mia', last_name: 'Manager', email: 'mia@store.test' } });
      return json({}, 404);
    });
    vi.stubGlobal('fetch', fetch);
    return fetch;
  }
  const closures = async () => (await registerCollections(store.orders).closures.find().exec()).map((doc) => doc.toJSON());
  const stored = async (id: string) => (await sessions().findOne(id).exec())!.toJSON();
  async function approveAs(email: string, password: string) {
    const dialog = within(await screen.findByTestId('approval-dialog'));
    fireEvent.change(dialog.getByTestId('approval-email'), { target: { value: email } });
    fireEvent.change(dialog.getByTestId('approval-password'), { target: { value: password } });
    await act(async () => { fireEvent.click(dialog.getByTestId('approval-approve')); });
    return dialog;
  }

  it('under the threshold: the count closes, the closure sheet shows, and Done brings back the open card prefilled with the count', async () => {
    await openTestRegister(store.orders, baseUrl);
    await mount();
    const count = await startCount();
    fireEvent.change(count.getByTestId('count-amount'), { target: { value: '100.00' } });
    // Not blind: the live variance line and the sheet's figures show.
    expect(count.getByTestId('count-variance').textContent).toMatch(/^Expected €100\.00 · /);
    await act(async () => { fireEvent.click(count.getByTestId('count-close')); });
    const sheet = within(await screen.findByTestId('closure-sheet'));
    expect(sheet.getByTestId('closure-number').textContent).toBe('Closure #1');
    expect(sheet.getByTestId('closure-figures')).toBeTruthy();
    expect(screen.queryByTestId('approval-dialog')).toBeNull();
    expect(screen.queryByTestId('closure-approved-by')).toBeNull();
    const [closure] = await closures();
    expect(closure).toMatchObject({ number: 1, counted: { cash: 10000 }, variance: { cash: 0 } });
    expect(closure.breakdowns).toMatchObject({ approved_by: null, register_name: 'Register 1', closed_by_name: 'admin@store.test' });
    await act(async () => { fireEvent.click(sheet.getByTestId('closure-done')); });
    await waitFor(() => expect(screen.queryByTestId('closure-sheet')).toBeNull());
    expect((screen.getByTestId('open-register-amount') as HTMLInputElement).value).toBe('100.00');
    expect(button('Cash')).toBeTruthy();
  });

  it('over the threshold, the hook\'s own gate (RegisterApprovalRequiredError) is the count\'s refusal, and nothing is written', async () => {
    const session = await openTestRegister(store.orders, baseUrl);
    await mount();
    const count = await startCount();
    fireEvent.change(count.getByTestId('count-amount'), { target: { value: '100.00' } });
    // A paid in lands in storage before the count renders it: the count sees exact, closeSession reads €10.00 short.
    await act(async () => {
      await registerCollections(store.orders).movements.insert({ id: 'raced-paid-in', session_id: session.id, type: 'paid_in',
        amountMinor: 1000, reason: 'Raced', created_at_gmt: new Date().toISOString(), created_by: 'admin@store.test' });
      fireEvent.click(count.getByTestId('count-close'));
    });
    expect((await screen.findByTestId('count-manager-line')).textContent).toBe(APPROVAL_REQUIRED_TEXT);
    expect(screen.queryByTestId('approval-dialog')).toBeNull();
    expect(await closures()).toEqual([]);
    expect(await stored(session.id)).toMatchObject({ status: 'counting' });
  });

  it('over the threshold, a manager\'s login approves: the close completes with approved_by frozen, and neither the password nor the token is kept', async () => {
    const fetch = stubMedusa();
    const logged = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => vi.spyOn(console, method));
    const cashier = localStorage.getItem('medusapos.session');
    const session = await openTestRegister(store.orders, baseUrl);
    await mount();
    await closeWith(await startCount(), '90.00');
    const dialog = within(await screen.findByTestId('approval-dialog'));
    expect(dialog.getByRole('heading').textContent).toBe('Manager approval');
    await approveAs('mia@store.test', PASSWORD);
    expect((await screen.findByTestId('closure-approved-by')).textContent).toBe('Approved by Mia Manager');
    expect(screen.queryByTestId('approval-dialog')).toBeNull();
    const [closure] = await closures();
    expect(closure).toMatchObject({ counted: { cash: 9000 }, variance: { cash: -1000 } });
    expect(closure.breakdowns).toMatchObject({ approved_by: 'user_mgr', approved_by_name: 'Mia Manager' });
    expect(await stored(session.id)).toMatchObject({ status: 'closed', approved_by: 'user_mgr', closed_by: 'admin@store.test' });
    // The approver signed in beside the cashier, never instead: the cashier's session and token are untouched.
    expect(localStorage.getItem('medusapos.session')).toBe(cashier);
    expect(JSON.parse(cashier!).token).not.toBe(TOKEN);
    // Only the approver's id and name are kept, for a resumed close.
    expect(JSON.parse(localStorage.getItem(`medusapos.approvers.${baseUrl}`)!)).toEqual({ user_mgr: 'Mia Manager' });
    // The password went only in the sign-in's body; neither it nor the approver's token is logged, stored or in a URL.
    const emailpass = fetch.mock.calls.filter(([url]) => String(url).endsWith('/auth/user/emailpass'));
    expect(emailpass).toHaveLength(1);
    expect(JSON.parse(String(emailpass[0][1]!.body))).toEqual({ email: 'mia@store.test', password: PASSWORD });
    const text = (value: unknown) => { try { return value instanceof Error ? `${value.message} ${value.stack}` : JSON.stringify(value) ?? String(value); } catch { return String(value); } };
    const everything = [
      ...logged.flatMap((spy) => spy.mock.calls.flat().map(text)),
      ...[...storageData.entries()].flat(),
      JSON.stringify(await closures()), JSON.stringify((await sessions().find().exec()).map((doc) => doc.toJSON())),
      ...fetch.mock.calls.map(([url]) => String(url)), window.location.href,
    ].join('\n');
    expect(everything).not.toContain(PASSWORD);
    expect(everything).not.toContain(TOKEN);

    fireEvent.click(screen.getByTestId('closure-done'));
    fireEvent.click(await screen.findByRole('button', { name: 'Open register panel' }));
    const figures = within(await screen.findByTestId('last-closure'));
    expect(figures.getByTestId('last-closure-approved-by').textContent).toBe('Approved by Mia Manager');
    expect(figures.getByTestId('last-closure-variance-cash').textContent).toBe('Short €10.00');
  });

  it('a wrong password keeps the dialog open with its message and an empty password; Cancel then leaves the count as it was', async () => {
    stubMedusa(() => json({ message: 'Invalid email or password' }, 401));
    const session = await openTestRegister(store.orders, baseUrl);
    await mount();
    const count = await startCount();
    await closeWith(count, '90.00');
    const dialog = await approveAs('mia@store.test', 'wrong-password');
    expect((await dialog.findByTestId('approval-error')).textContent).toBe("That email and password didn't work.");
    expect((dialog.getByTestId('approval-password') as HTMLInputElement).value).toBe('');
    expect(await closures()).toEqual([]);
    expect(await stored(session.id)).toMatchObject({ status: 'counting' });
    await act(async () => { fireEvent.click(dialog.getByTestId('approval-cancel')); });
    expect(screen.queryByTestId('approval-dialog')).toBeNull();
    expect(count.getByTestId('count-manager-line').textContent).toBe('Approval was not granted. The count is unchanged.');
    expect((count.getByTestId('count-amount') as HTMLInputElement).value).toBe('90.00');
    expect(await closures()).toEqual([]);
  });

  it.each(['the catalogue is offline', 'the sign-in cannot reach the backend'])(
    'when %s, approval says to connect or count again, with only Cancel, which leaves the count unchanged', async (why) => {
      const fetch = stubMedusa(() => { throw new TypeError('Failed to fetch'); });
      if (why === 'the catalogue is offline') {
        vi.mocked(useReplicatedProducts).mockReturnValue({ products: [shirt], state: 'offline', error: null, lastSyncedAt: null,
          stockOverlay: undefined, lastStockCheckAt: null, reconcileStock: vi.fn(async () => {}), unlisted: undefined });
      }
      const session = await openTestRegister(store.orders, baseUrl);
      await mount();
      const count = await startCount();
      await closeWith(count, '90.00');
      const dialog = why === 'the catalogue is offline'
        ? within(await screen.findByTestId('approval-dialog')) : await approveAs('mia@store.test', PASSWORD);
      expect((await dialog.findByTestId('approval-offline')).textContent).toBe(APPROVE_OFFLINE);
      expect(dialog.queryByTestId('approval-approve')).toBeNull();
      expect(dialog.queryByTestId('approval-password')).toBeNull();
      expect(dialog.getAllByRole('button').map((element) => element.textContent)).toEqual(['Cancel']);
      if (why === 'the catalogue is offline') expect(fetch).not.toHaveBeenCalled();
      await act(async () => { fireEvent.click(dialog.getByTestId('approval-cancel')); });
      expect(count.getByTestId('count-manager-line').textContent).toBe('Approval was not granted. The count is unchanged.');
      expect((count.getByTestId('count-amount') as HTMLInputElement).value).toBe('90.00');
      expect(await stored(session.id)).toMatchObject({ status: 'counting' });
      expect(await closures()).toEqual([]);
    });

  it('a close interrupted after the session closed (a restart) offers Finish closing, which writes the stored count with the kept approver name', async () => {
    const session = await openTestRegister(store.orders, baseUrl);
    await startCounting(sessions(), session.id);
    await closeSession(sessions(), session.id, { counted: { cash: 9000 }, closedBy: 'admin@store.test', approvedBy: 'user_mgr' });
    rememberApprover(localStorage, baseUrl, 'user_mgr', 'Mia Manager');
    await mount();
    const finish = within(await screen.findByTestId('finish-close'));
    expect(screen.queryByTestId('open-register-card')).toBeNull();
    await act(async () => { fireEvent.click(finish.getByTestId('finish-close-button')); });
    expect((await screen.findByTestId('closure-approved-by')).textContent).toBe('Approved by Mia Manager');
    const [closure] = await closures();
    expect(closure).toMatchObject({ counted: { cash: 9000 }, variance: { cash: -1000 } });
    expect(closure.breakdowns).toMatchObject({ approved_by: 'user_mgr', approved_by_name: 'Mia Manager' });
    fireEvent.click(screen.getByTestId('closure-done'));
    expect(await screen.findByTestId('open-register-card')).toBeTruthy();
    expect(screen.queryByTestId('finish-close')).toBeNull();
  });

  it('the last closure\'s figures come from the frozen closure, unchanged by a sale stamped to its session afterwards', async () => {
    await openTestRegister(store.orders, baseUrl);
    await mount();
    await screen.findByRole('button', { name: 'Open register panel' });
    fireEvent.click(button('Shirt'));
    await act(async () => { fireEvent.click(button('Card terminal')); });
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Payment approved on terminal' })); });
    await act(async () => { fireEvent.click(button('New sale')); });
    await closeWith(await startCount(), '100.00');
    await act(async () => { fireEvent.click(await screen.findByTestId('closure-done')); });
    // A sale stamped to the closed session after its close (a raced stamp): a live recompute would count it.
    await act(async () => { await store.orders.insert({ ...record.mock.calls[0][0], id: 'raced-sale' }); });
    fireEvent.click(await screen.findByRole('button', { name: 'Open register panel' }));
    const figures = within(await screen.findByTestId('last-closure'));
    expect(figures.getByRole('heading').textContent).toBe('Last closure · Closure #1');
    expect(figures.getByTestId('last-closure-sales').textContent).toBe('€15.00');
    expect(figures.getByTestId('last-closure-float').textContent).toBe('€100.00');
    expect(figures.getByTestId('last-closure-expected-cash').textContent).toBe('€100.00');
    expect(figures.getByTestId('last-closure-counted-cash').textContent).toBe('€100.00');
    expect(figures.getByTestId('last-closure-variance-cash').textContent).toBe('Exact');
    expect(figures.getByTestId('last-closure-unsynced').textContent).toBe('1 sale not sent yet · €15.00');
    expect(figures.queryByTestId('last-closure-approved-by')).toBeNull();
    fireEvent.click(figures.getByTestId('last-closure-done'));
    await waitFor(() => expect(screen.queryByTestId('last-closure')).toBeNull());
  });

  it('at 360, Close register shows the count in the cart view, even with an empty cart', async () => {
    setWindowWidth(360);
    await openTestRegister(store.orders, baseUrl);
    await mount();
    await startCount();
    expect(button('Products')).toBeTruthy();
    await waitFor(() => expect(pill()).toBe('Counting'));
  });
});

// The Front desk's review (2026-09-28): the pill is never a dead label, and on a phone the control ends existing rows.
describe('the register control', () => {
  it('at 1280, tapping "Choose a register" brings up the gate: the picker, focused', async () => {
    await mount();
    const picker = await screen.findByTestId('register-picker');
    await waitFor(() => expect(pill()).toBe('Choose a register'));
    expect(screen.getByTestId('register-bar').contains(screen.getByTestId('register-bar-pill'))).toBe(true);
    fireEvent.click(button('Choose a register'));
    expect(picker.contains(document.activeElement)).toBe(true);
  });

  it('at 360, with the bar on the status line and an empty cart, tapping "Register closed" opens the cart view with the open card above the empty cart', async () => {
    setWindowWidth(360);
    await bindRegister(sessions(), baseUrl, { id: 'register-1', name: 'Register 1' });
    await mount();
    await waitFor(() => expect(pill()).toBe('Register closed'));
    // No strip: the bar ends Catalogue's status line.
    expect(screen.getByTestId('catalogue-status-row').contains(screen.getByTestId('register-bar'))).toBe(true);
    expect(screen.queryByTestId('open-register-card')).toBeNull();
    // The cart bar stays disabled; only the pill opens the cart view.
    expect(button('Cart is empty').getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(button('Register closed'));
    const card = await screen.findByTestId('open-register-card');
    // One tap also focuses the gate, which mounted for it (the float field).
    expect(card.contains(document.activeElement)).toBe(true);
    const empty = screen.getByText('Scan or tap a product to start a sale.');
    expect(card.compareDocumentPosition(empty) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The control now ends the "‹ Products" row.
    expect(button('Products').parentElement!.contains(screen.getByTestId('register-bar-pill'))).toBe(true);
  });

  it.each([1280, 360])('at %i, with a session open, tapping the pill ("Offline") opens the panel', async (width) => {
    setWindowWidth(width);
    vi.mocked(useReplicatedProducts).mockReturnValue({ products: [shirt], state: 'offline', error: null, lastSyncedAt: null,
      stockOverlay: undefined, lastStockCheckAt: null, reconcileStock: vi.fn(async () => {}), unlisted: undefined });
    await openTestRegister(store.orders, baseUrl);
    await mount();
    await waitFor(() => expect(pill()).toBe('Offline'));
    fireEvent.click(button('Offline'));
    expect(await screen.findByTestId('register-panel')).toBeTruthy();
  });
});

// The Front desk (2026-09-28): on a phone the status line shares its row with the register pill, so it is short.
describe('the catalogue status line', () => {
  it.each([
    [1280, 'MedusaJS · Up to date · 1 products · 2 not sold in this channel · Failed to fetch'],
    [360, 'Up to date · Failed to fetch · 1 products'],
  ])('at %i reads %j', async (width, text) => {
    setWindowWidth(width);
    vi.mocked(useReplicatedProducts).mockReturnValue({ products: [shirt], state: 'synced', error: 'Failed to fetch', lastSyncedAt: null,
      stockOverlay: undefined, lastStockCheckAt: null, reconcileStock: vi.fn(async () => {}), unlisted: { count: 2, stale: false } });
    await mount();
    await waitFor(() => expect(pill()).toBe('Choose a register'));
    expect(within(screen.getByTestId('catalogue-status-row')).getByText(text)).toBeTruthy();
  });
});

// The #88 review.
describe('the tender gate', () => {
  // The #88 delta re-review: requireOpen() reads storage ahead of the render, and useSale pins the rendered session.
  it('a tap straight after the session opens in storage waits for it to render, and the sale is stamped with it', async () => {
    await bindRegister(sessions(), baseUrl, { id: 'register-1', name: 'Register 1' });
    await mount();
    await screen.findByTestId('open-register-card');
    fireEvent.click(button('Shirt'));
    // Opened straight in storage, then tapped before the register's watcher renders it (as the reviewer reproduced).
    const opened = await openSession(sessions(), { registerId: 'register-1', expectedFloatMinor: null, countedFloatMinor: 10000,
      openedBy: 'admin@store.test', businessDay: { year: 2026, month: 9, day: 28 }, storeKey: baseUrl });
    fireEvent.click(button('Card terminal'));
    await screen.findByRole('button', { name: 'Open register panel' });
    const approve = await screen.findByRole('button', { name: 'Payment approved on terminal' });
    await act(async () => { fireEvent.click(approve); });
    await waitFor(() => expect(record).toHaveBeenCalledOnce());
    expect(record.mock.calls[0][0].sessionId).toBe(opened.id);
    expect(record.mock.calls[0][0]).not.toHaveProperty('lateSessionId');
  });

  it('pins the session for the tender: closed during it, the completed sale is late, with no sessionId', async () => {
    const session = await openTestRegister(store.orders, baseUrl);
    await mount();
    await screen.findByRole('button', { name: 'Open register panel' });
    fireEvent.click(button('Shirt'));
    await act(async () => { fireEvent.click(button('Card terminal')); });
    const approve = await screen.findByRole('button', { name: 'Payment approved on terminal' });
    // A close lands under the tender (as a server close or another path could): saleSession goes undefined.
    await act(async () => { await (await sessions().findOne(session.id).exec())!.incrementalPatch({ status: 'closed' }); });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Open register panel' })).toBeNull());
    await act(async () => { fireEvent.click(approve); });
    await waitFor(() => expect(record).toHaveBeenCalledOnce());
    expect(record.mock.calls[0][0]).toMatchObject({ lateSessionId: session.id });
    expect(record.mock.calls[0][0]).not.toHaveProperty('sessionId');
  });

  it('refuses while the order store is still opening, and records nothing once it opens', async () => {
    await openTestRegister(store.orders, baseUrl);
    vi.mocked(useOutboxContext).mockReturnValue({ ...useOutboxContext(), orders: null });
    const tree = (orders: typeof store.orders | null) =>
      <SessionProvider><RegisterProvider orders={orders}><ProductsScreen /></RegisterProvider><PortalHost /></SessionProvider>;
    let view!: ReturnType<typeof render>;
    await act(async () => { view = render(tree(null)); });
    fireEvent.click(button('Shirt'));
    await act(async () => { fireEvent.click(button('Cash')); });
    expect(screen.getByRole('alert').textContent).toBe(GETTING_READY);
    expect(screen.queryByRole('button', { name: 'Complete sale' })).toBeNull();
    vi.mocked(useOutboxContext).mockReturnValue({ ...useOutboxContext(), orders: store.orders });
    await act(async () => { view.rerender(tree(store.orders)); });
    await screen.findByRole('button', { name: 'Open register panel' });
    expect(screen.queryByRole('button', { name: 'Complete sale' })).toBeNull();
    expect(button('Cash')).toBeTruthy();
    expect(record).not.toHaveBeenCalled();
  });

  it('while a check is pending, ignores further Cash and Card taps: one tender, with the first tap\'s method', async () => {
    await openTestRegister(store.orders, baseUrl);
    await mount();
    await screen.findByRole('button', { name: 'Open register panel' });
    fireEvent.click(button('Shirt'));
    await act(async () => {
      fireEvent.click(button('Card terminal'));
      fireEvent.click(button('Card terminal'));
      fireEvent.click(button('Cash'));
    });
    expect(await screen.findByRole('button', { name: 'Payment approved on terminal' })).toBeTruthy();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(screen.queryByRole('button', { name: 'Complete sale' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Payment approved on terminal' })).toBeTruthy();
  });
});
