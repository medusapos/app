// @vitest-environment jsdom
// The store-verified approval (ADR 0023) through the one "Manager approval" dialog: the count's close carries the
// store's proof at register contract 3 while the store holds the session, and a closure the store refused gets the
// panel's card, which asks again. Otherwise the count keeps ADR 0018's second login, with no proof.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createOrderBuilder, finalizeOrder, type ApprovalNeeded, type PosOrder } from '@tallyui/pos';
import { PortalHost } from '@tallyui/primitives';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RegisterGate, RegisterPanelSheet } from '../components/register';
import { APPROVE_OFFLINE } from '../components/register-close';
import { closeOrderStores, openOrderStore } from '../lib/order-store';
import { useOutboxContext } from '../lib/outbox-context';
import { useRegister, type RegisterContextValue } from '../lib/register-context';
import type { Session } from '../lib/session';
import { useSession } from '../lib/session-context';
import { openRegisterFixture, OPEN_SESSION } from './register-fixture';

vi.mock('expo-localization', () => ({ getLocales: () => [{ languageTag: 'en-GB' }] }));
vi.mock('../lib/register-context', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/register-context')>(), useRegister: vi.fn(),
}));
vi.mock('../lib/session-context', () => ({ useSession: vi.fn() }));
// Only the order collection the panel reads; none until a test opens one.
vi.mock('../lib/outbox-context', () => ({ useOutboxContext: vi.fn(() => ({ orders: null })) }));

const baseUrl = 'https://store-approval.test';
const CASHIER_TOKEN = 'cashier-token-abc';
const PROOF = 'store-proof-123';
const STORE_CAPABILITIES = { register: 3, registerApproval: { thresholdMinor: 500 } } as Session['capabilities'];
const VARIANCE = { cash: -1000 };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** The store's approval route and ADR 0018's sign-in, as `fetch` sees them. */
function stubStore() {
  const fetch = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path === '/tally/v1/register-approvals') return json({ approval: PROOF, approvedBy: 'user_store', approvedByName: 'Sam Store', expiresAt: '2026-11-10T12:00:00.000Z' });
    if (path === '/auth/user/emailpass') return json({ token: 'approver-token' });
    if (path === '/admin/users/me') return json({ user: { id: 'user_mgr', first_name: 'Mia', last_name: 'Manager' } });
    return json({}, 404);
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
const calls = (fetch: ReturnType<typeof stubStore>, path: string) => fetch.mock.calls.filter(([url]) => new URL(String(url)).pathname === path);

let context: RegisterContextValue;
let closureVariance: ReturnType<typeof vi.fn>;
let reapproveClosure: ReturnType<typeof vi.fn>;
function signIn(capabilities: Session['capabilities']) {
  vi.mocked(useSession).mockReturnValue({ session: { baseUrl, email: 'admin@store.test', token: CASHIER_TOKEN, capabilities } } as ReturnType<typeof useSession>);
}
/** The fixture's register, counting (or between sessions with `extra`), with this test's actions. */
function withRegister(extra: Record<string, unknown>) {
  const fixture = openRegisterFixture();
  closureVariance = vi.fn(async () => VARIANCE);
  reapproveClosure = vi.fn(async () => {});
  const register = { ...fixture.register, varianceThreshold: 500, ...extra,
    actions: { ...fixture.register.actions, closureVariance, reapproveClosure } } as unknown as RegisterContextValue['register'];
  context = { ...fixture, register, close: { ...fixture.close, run: vi.fn(async () => ({ id: 'closure-1' })) } } as unknown as RegisterContextValue;
  vi.mocked(useRegister).mockReturnValue(context);
}

beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

async function mountCount(liveAtStore: boolean) {
  withRegister({ session: { ...OPEN_SESSION, status: 'counting' }, liveAtStore });
  await act(async () => {
    render(<><RegisterGate currency="EUR" online refused={null} cartEmpty openSaleCount={0} focus={{ key: 0, handled: { current: 0 } }}>{null}</RegisterGate><PortalHost /></>);
  });
  const count = within(screen.getByTestId('register-count'));
  fireEvent.change(count.getByTestId('count-amount'), { target: { value: '90.00' } });
  await act(async () => { fireEvent.click(count.getByTestId('count-close')); });
  return count;
}
async function approve(email = 'mia@store.test', password = 'manager-secret') {
  const dialog = within(await screen.findByTestId('approval-dialog'));
  fireEvent.change(dialog.getByTestId('approval-email'), { target: { value: email } });
  fireEvent.change(dialog.getByTestId('approval-password'), { target: { value: password } });
  await act(async () => { fireEvent.click(dialog.getByTestId('approval-approve')); });
}

describe('the count over the threshold', () => {
  it("store-verified: the close carries the store's proof, the approver and the approved variance", async () => {
    signIn(STORE_CAPABILITIES);
    const fetch = stubStore();
    await mountCount(true);
    await approve();
    expect(closureVariance).toHaveBeenCalledWith({ cash: 9000 });
    const [route] = calls(fetch, '/tally/v1/register-approvals');
    expect(JSON.parse(String(route[1]!.body))).toEqual({ sessionId: OPEN_SESSION.id, variance: VARIANCE, email: 'mia@store.test', password: 'manager-secret' });
    expect(new Headers(route[1]!.headers).get('Authorization')).toBe(`Bearer ${CASHIER_TOKEN}`);
    expect(calls(fetch, '/auth/user/emailpass')).toEqual([]);
    expect(context.close.run).toHaveBeenCalledWith({ counted: { cash: 9000 }, approvedBy: 'user_store', approvedByName: 'Sam Store',
      approval: PROOF, approvedVariance: VARIANCE }, true);
    expect(screen.queryByTestId('approval-dialog')).toBeNull();
    expect(JSON.parse(localStorage.getItem(`medusapos.approvers.${baseUrl}`)!)).toEqual({ user_store: 'Sam Store' });
  });

  it('store-verified: Cancel closes nothing and says approval was not granted', async () => {
    signIn(STORE_CAPABILITIES);
    const fetch = stubStore();
    const count = await mountCount(true);
    const dialog = within(await screen.findByTestId('approval-dialog'));
    await act(async () => { fireEvent.click(dialog.getByTestId('approval-cancel')); });
    expect(count.getByTestId('count-manager-line').textContent).toBe('Approval was not granted. The count is unchanged.');
    expect(context.close.run).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['not live at the store: the ADR 0018 second login, with no proof', STORE_CAPABILITIES, false],
    ['a store without registerApproval: the ADR 0018 second login, with no proof', { register: 3 } as Session['capabilities'], true],
  ])('%s', async (_name, capabilities, liveAtStore) => {
    signIn(capabilities);
    const fetch = stubStore();
    await mountCount(liveAtStore);
    await approve();
    expect(calls(fetch, '/tally/v1/register-approvals')).toEqual([]);
    expect(calls(fetch, '/auth/user/emailpass')).toHaveLength(1);
    expect(closureVariance).not.toHaveBeenCalled();
    expect(context.close.run).toHaveBeenCalledWith({ counted: { cash: 9000 }, approvedBy: 'user_mgr', approvedByName: 'Mia Manager' }, true);
  });
});

describe('a closure the store refused', () => {
  const needed = (liveAtStore: boolean): ApprovalNeeded => ({ closureId: 'closure-9', sessionId: 'session-9', variance: { cash: -1500 },
    code: 'register_approval_invalid', liveAtStore });
  // The till's own pos_orders (memory storage), as the outbox holds them.
  let store: Awaited<ReturnType<typeof openOrderStore>>;
  beforeEach(async () => {
    store = await openOrderStore(`https://refused-${crypto.randomUUID()}.test`);
    vi.mocked(useOutboxContext).mockReturnValue({ orders: store.orders } as ReturnType<typeof useOutboxContext>);
  });
  afterEach(async () => { await closeOrderStores(); });
  let minute = 0;
  /** A sale of the payments' total, taken in `sessionId`; refused with `code` unless `syncStatus` says otherwise. */
  function sale(id: string, payments: { method: 'cash' | 'external'; amountMinor: number }[], code: string | null,
    overrides: Partial<PosOrder> = {}): PosOrder {
    const total = payments.reduce((sum, payment) => sum + payment.amountMinor, 0);
    const builder = createOrderBuilder({ currency: 'EUR', taxContext: { pricesIncludeTax: false, getTaxRatePpm: () => 0 } });
    builder.addLine({ productId: 'shirt', name: 'Shirt', unitPrice: { amount: total, currency: 'EUR' } });
    // Paid in full to finalize; the stored payments are this test's own, below.
    builder.addPayment({ method: 'cash', amountMinor: total });
    const order = finalizeOrder(builder.getSnapshot());
    return { ...order, id, saleId: id, sessionId: 'session-9', createdAt: new Date(2026, 10, 23, 9, minute++).toISOString(),
      payments: payments.map((payment) => ({ id: crypto.randomUUID(), ...payment })),
      ...(code ? { syncStatus: 'rejected', error: { code, message: 'Refused' } } : { syncStatus: 'applied' }), ...overrides };
  }
  const refusedRows = (dialog: ReturnType<typeof within>) => within(dialog.getByTestId('approval-refused-sales'))
    .getAllByTestId(/^approval-refused-sale-/).map((row) => row.getAttribute('data-testid'));
  /** Lets the dialog's read of the till's sales land. */
  const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 50)));

  it('lists the refused sales behind the variance, each with its reference, cash and code; not one a successor replaced', async () => {
    const replaced = sale('0190aaaa-0000-7000-8000-00000000c003', [{ method: 'cash', amountMinor: 300 }], 'total_mismatch');
    await store.orders.bulkInsert([
      sale('0190aaaa-0000-7000-8000-00000000a001', [{ method: 'cash', amountMinor: 1000 }], 'insufficient_stock'),
      sale('0190aaaa-0000-7000-8000-00000000b002', [{ method: 'external', amountMinor: 500 }, { method: 'cash', amountMinor: 200 }], 'figures_mismatch'),
      replaced,
      sale('0190aaaa-0000-7000-8000-00000000d004', [{ method: 'cash', amountMinor: 300 }], null, { saleId: replaced.id }),
    ]);
    stubStore();
    await mountCard(true);
    await settle();
    const dialog = within(await screen.findByTestId('approval-dialog'));
    expect(refusedRows(dialog)).toEqual(['approval-refused-sale-0190aaaa-0000-7000-8000-00000000a001',
      'approval-refused-sale-0190aaaa-0000-7000-8000-00000000b002']);
    const cash = within(dialog.getByTestId('approval-refused-sale-0190aaaa-0000-7000-8000-00000000a001'));
    expect(cash.getByText('Order 0000a001 · insufficient_stock')).toBeTruthy();
    expect(cash.getByText('€10.00')).toBeTruthy();
    const split = within(dialog.getByTestId('approval-refused-sale-0190aaaa-0000-7000-8000-00000000b002'));
    expect(split.getByText('Order 0000b002 · figures_mismatch')).toBeTruthy();
    expect(split.getByText('€2.00')).toBeTruthy();
  });

  it('with no refused sales, the dialog has no refused-sales list', async () => {
    await store.orders.insert(sale('0190aaaa-0000-7000-8000-00000000e005', [{ method: 'cash', amountMinor: 1000 }], null));
    stubStore();
    await mountCard(true);
    await settle();
    const dialog = within(await screen.findByTestId('approval-dialog'));
    expect(dialog.queryByTestId('approval-refused-sales')).toBeNull();
  });

  it("does not list another session's refused sale", async () => {
    await store.orders.bulkInsert([
      sale('0190aaaa-0000-7000-8000-00000000f006', [{ method: 'cash', amountMinor: 1000 }], 'insufficient_stock'),
      sale('0190aaaa-0000-7000-8000-000000000007', [{ method: 'cash', amountMinor: 400 }], 'overpaid', { sessionId: 'session-8' }),
    ]);
    stubStore();
    await mountCard(true);
    await settle();
    const dialog = within(await screen.findByTestId('approval-dialog'));
    expect(refusedRows(dialog)).toEqual(['approval-refused-sale-0190aaaa-0000-7000-8000-00000000f006']);
  });
  async function mountCard(liveAtStore: boolean) {
    signIn(STORE_CAPABILITIES);
    withRegister({ session: null, lastClosure: { id: 'closure-9' }, approvalNeeded: needed(liveAtStore), liveAtStore: false });
    await act(async () => {
      render(<><RegisterPanelSheet currency="EUR" store={{ name: 'Shop' }} online open onOpenChange={vi.fn()} /><PortalHost /></>);
    });
    // The panel, not the last closure's figures, so the card shows.
    expect(screen.queryByTestId('last-closure')).toBeNull();
    const card = within(screen.getByTestId('register-panel-reapproval'));
    await act(async () => { fireEvent.click(card.getByTestId('register-panel-reapprove')); });
    return card;
  }

  it("a refused closure shows the approval card, and Approve sends the store's new proof", async () => {
    const fetch = stubStore();
    await mountCard(true);
    await approve();
    const [route] = calls(fetch, '/tally/v1/register-approvals');
    expect(JSON.parse(String(route[1]!.body))).toMatchObject({ sessionId: 'session-9', variance: { cash: -1500 } });
    expect(new Headers(route[1]!.headers).get('Authorization')).toBe(`Bearer ${CASHIER_TOKEN}`);
    expect(reapproveClosure).toHaveBeenCalledWith({ closureId: 'closure-9', approval: PROOF, approvedBy: 'user_store' });
    expect(screen.queryByTestId('approval-dialog')).toBeNull();
  });

  it('a refused closure not live at the store: the dialog says to connect and approves nothing', async () => {
    const fetch = stubStore();
    await mountCard(false);
    const dialog = within(await screen.findByTestId('approval-dialog'));
    expect(dialog.getByTestId('approval-offline').textContent).toBe(APPROVE_OFFLINE);
    expect(dialog.getAllByRole('button').map((element) => element.textContent)).toEqual(['Cancel']);
    await act(async () => { fireEvent.click(dialog.getByTestId('approval-cancel')); });
    expect(reapproveClosure).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
