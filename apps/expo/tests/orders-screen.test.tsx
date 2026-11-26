// @vitest-environment jsdom
// @ts-expect-error no @types/react-dom in this Expo/React Native app
import { createPortal } from 'react-dom';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { router } from 'expo-router';
import { orderReference } from '@tallyui/components';
import { PortalHost } from '@tallyui/primitives';
import { formatMoney } from '@tallyui/core';
import { createOrderBuilder, finalizeOrder, type PosOrder } from '@tallyui/pos';
import { saveSession } from '../lib/session';
import { SessionProvider } from '../lib/session-context';
import { useOutboxContext } from '../lib/outbox-context';
import { formatDate } from '../lib/format-date';
import OrdersScreen from '../app/orders';
import { AppFrame, useFrameAccountPublisher } from '../components/app-frame';
import { setWindowWidth } from './window-width';

vi.mock('expo-router', () => ({
  Redirect: ({ href }: { href: string }) => <span>redirect:{href}</span>,
  router: { replace: vi.fn(), push: vi.fn(), dismissTo: vi.fn() }, usePathname: () => '/orders',
  Stack: { Screen: ({ options }: { options: { title?: string; headerShown?: boolean; headerLeft?: () => ReactNode; headerRight?: () => ReactNode } }) =>
    <><div data-testid="header-left" data-header-shown={String(options.headerShown)} data-title={options.title}>
      {options.headerLeft?.()}</div>
      {/* The stack draws headerRight only when the header shows, outside the screen's main landmark. */}
      {createPortal(<div data-testid="header-right">{options.headerShown && options.headerRight?.()}</div>, document.body)}</> },
}));

function AccountPublisher({ open }: { open: () => void }) {
  useFrameAccountPublisher({ displayName: 'Dana Cole', initials: 'DC', open });
  return null;
}
vi.mock('../lib/outbox-context', () => ({ useOutboxContext: vi.fn() }));
vi.mock('expo-linking', () => ({ openURL: vi.fn().mockResolvedValue(true) }));
// The store is out of reach here, so Orders shows this till's own sales, which these tests pin; the store-wide
// list is orders-store-wide.test.tsx.
vi.mock('../lib/pos-connector', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/pos-connector')>();
  const { CustomerServiceError } = await import('@tallyui/core');
  const listOrders = () => Promise.reject(new CustomerServiceError('network', 'offline'));
  return { ...actual, createPosConnector: () => ({ ...actual.createPosConnector(), listOrders }) };
});

const emptyText = 'No orders yet.';

beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  });
  saveSession(localStorage, { baseUrl: 'https://store.test', email: 'admin@store.test', token: 'token' });
  vi.mocked(useOutboxContext).mockReturnValue({
    orders: null, state: { pending: 0, sending: false }, recent: [], savesInFlight: 0, stuckCommandIds: [],
    record: vi.fn().mockResolvedValue(undefined), flush: vi.fn().mockResolvedValue(undefined),
    requeue: vi.fn().mockResolvedValue(0), discard: vi.fn(), isStored: vi.fn().mockResolvedValue(false),
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

async function mount() {
  render(<SessionProvider><OrdersScreen /></SessionProvider>);
  await act(async () => {});
}

describe('OrdersScreen', () => {
  it('shows TallyUI\'s single empty state when the till has no sales (#195, TallyUI 3.0.2)', async () => {
    await mount();
    expect(screen.getAllByText(emptyText)).toHaveLength(1);
    expect(screen.queryByText('No sales on this till yet. Completed sales show here.')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Send feedback' })).toBeNull();
  });

  it('hides the empty state once there is a sale (#195)', async () => {
    const builder = createOrderBuilder({ currency: 'EUR', taxContext: { pricesIncludeTax: false, getTaxRatePpm: () => 0 } });
    builder.addLine({ productId: 'shirt', variantId: 'blue', name: 'Blue shirt', unitPrice: { amount: 1200, currency: 'EUR' } });
    builder.addPayment({ method: 'cash', amountMinor: 1200 });
    vi.mocked(useOutboxContext).mockReturnValue({ ...useOutboxContext(), recent: [finalizeOrder(builder.getSnapshot())] });
    await mount();
    expect(screen.queryByText(emptyText)).toBeNull();
  });

  it('on a phone the header has one control, the frame\'s Menu, whose drawer goes back to the sale (#195)', () => {
    setWindowWidth(390, 844);
    render(<SessionProvider><AppFrame signedIn><OrdersScreen /></AppFrame></SessionProvider>);
    const menu = screen.getByTestId('frame-menu');
    expect(screen.getByTestId('header-left').dataset.headerShown).toBe('true');
    expect(screen.getByTestId('header-left').contains(menu)).toBe(true);
    expect(within(screen.getByTestId('header-left')).getAllByRole('button')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Products' })).toBeNull();
    fireEvent.click(menu);
    fireEvent.click(within(screen.getByTestId('nav-drawer')).getByTestId('nav-item-sale'));
    expect(router.dismissTo).toHaveBeenCalledExactlyOnceWith('/');
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('on a wide window the header has no back control; the rail stands in for it', () => {
    setWindowWidth(1440, 900);
    render(<SessionProvider><AppFrame signedIn><OrdersScreen /></AppFrame></SessionProvider>);
    expect(screen.getByTestId('header-left').childElementCount).toBe(0);
    expect(screen.getByTestId('nav-rail')).toBeTruthy();
    // v2's Orders has no title bar on a wide window; the screen is the named main landmark instead.
    expect(screen.getByTestId('header-left').dataset.headerShown).toBe('false');
    expect(screen.getByTestId('header-left').dataset.title).toBe('Orders');
    expect(screen.getByRole('main', { name: 'Orders' }).contains(screen.getByTestId('orders-search'))).toBe(true);
  });
  it('the account avatar ends the search row on a wide window and is the header\'s right button on a phone (row 14a)', () => {
    const open = vi.fn();
    const mountFramed = () => render(<SessionProvider><AppFrame signedIn><AccountPublisher open={open} /><OrdersScreen /></AppFrame></SessionProvider>);
    setWindowWidth(1440, 900);
    const { unmount } = mountFramed();
    const avatar = screen.getByTestId('area-user-menu');
    expect(screen.getByRole('main', { name: 'Orders' }).contains(avatar)).toBe(true);
    expect(avatar.parentElement!.contains(screen.getByTestId('orders-search'))).toBe(true);
    expect(avatar.parentElement!.lastElementChild).toBe(avatar);
    fireEvent.click(avatar);
    expect(open).toHaveBeenCalledOnce();
    unmount();
    setWindowWidth(390, 844);
    mountFramed();
    const phoneAvatar = screen.getByTestId('area-user-menu');
    expect(screen.getByRole('main', { name: 'Orders' }).contains(phoneAvatar)).toBe(false);
    expect(screen.getByTestId('header-right').contains(phoneAvatar)).toBe(true);
  });

});

describe('order detail (row 10)', () => {
  beforeEach(() => { setWindowWidth(1024, 768); });
  function sale(name: string, syncStatus: PosOrder['syncStatus'], extra: Partial<PosOrder> = {}): PosOrder {
    const builder = createOrderBuilder({ currency: 'EUR', taxContext: { pricesIncludeTax: false, getTaxRatePpm: () => 0 } });
    builder.addLine({ productId: name, variantId: name, name, unitPrice: { amount: 1200, currency: 'EUR' } });
    builder.addPayment({ method: 'cash', amountMinor: 1200 });
    return { ...finalizeOrder(builder.getSnapshot()), syncStatus, ...extra };
  }
  function withSales(...recent: PosOrder[]) {
    vi.mocked(useOutboxContext).mockReturnValue({ ...useOutboxContext(), recent });
  }
  // The app's root layout holds the PortalHost the sheet renders into.
  async function mount() {
    render(<SessionProvider><OrdersScreen /><PortalHost /></SessionProvider>);
    await act(async () => {});
  }

  it('Open shows the sale in TallyUI\'s OrderDetail sheet, and Close removes it', async () => {
    const order = sale('Blue shirt', 'applied');
    withSales(order);
    await mount();
    expect(screen.queryByTestId('order-detail-sheet')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: `Open order ${orderReference(order)}` }));
    const sheet = within(await screen.findByTestId('order-detail-sheet'));
    expect(sheet.getAllByText(`Order ${orderReference(order)}`).length).toBeGreaterThan(0);
    expect(sheet.getByText('Completed')).toBeTruthy();
    expect(sheet.getByText('Blue shirt x1')).toBeTruthy();
    expect(sheet.getByText('Guest')).toBeTruthy();
    expect(sheet.getByText('Cash')).toBeTruthy();
    expect(sheet.getAllByText(formatMoney({ amount: order.totalMinor, currency: 'EUR' })!).length).toBeGreaterThan(0);
    fireEvent.click(sheet.getByTestId('order-detail-close'));
    await waitFor(() => expect(screen.queryByTestId('order-detail-sheet')).toBeNull());
  });

  it('shows Pending for an unsynced sale and Cancelled for a refused one', async () => {
    const pending = sale('Blue shirt', 'pending');
    const rejected = sale('Red hat', 'rejected', { error: { code: 'platform_error', message: 'Refused' } });
    withSales(pending, rejected);
    await mount();
    fireEvent.click(within(screen.getByTestId(`orders-row-${pending.id}`)).getByRole('button', { name: `Open order ${orderReference(pending)}` }));
    expect(within(await screen.findByTestId('order-detail-sheet')).getByText('Pending')).toBeTruthy();
    fireEvent.click(screen.getByTestId('order-detail-close'));
    await waitFor(() => expect(screen.queryByTestId('order-detail-sheet')).toBeNull());
    fireEvent.click(within(screen.getByTestId(`orders-row-${rejected.id}`)).getByRole('button', { name: `Open order ${orderReference(rejected)}` }));
    expect(within(await screen.findByTestId('order-detail-sheet')).getByText('Cancelled')).toBeTruthy();
  });

  it('keeps Retry under Needs attention for a refused sale it can requeue', async () => {
    const rejected = sale('Blue shirt', 'rejected', { error: { code: 'platform_error', message: 'Refused' } });
    withSales(rejected);
    await mount();
    expect(screen.getByText('Needs attention')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    expect(useOutboxContext().requeue).toHaveBeenCalledExactlyOnceWith([rejected.id]);
  });

  it('a search hides the other sale\'s row and an open sheet for a hidden sale stays open', async () => {
    const blue = sale('Blue shirt', 'applied');
    const red = sale('Red hat', 'applied');
    withSales(blue, red);
    await mount();
    fireEvent.click(within(screen.getByTestId(`orders-row-${red.id}`)).getByRole('button', { name: `Open order ${orderReference(red)}` }));
    expect(await screen.findByTestId('order-detail-sheet')).toBeTruthy();
    fireEvent.change(screen.getByTestId('orders-search'), { target: { value: 'blue' } });
    expect(screen.getByTestId(`orders-row-${blue.id}`)).toBeTruthy();
    expect(screen.queryByTestId(`orders-row-${red.id}`)).toBeNull();
    expect(within(screen.getByTestId('order-detail-sheet')).getByText('Red hat x1')).toBeTruthy();
  });
});

describe('orders table (row 10.1)', () => {
  function sale(name: string, syncStatus: PosOrder['syncStatus'], extra: Partial<PosOrder> = {}): PosOrder {
    const builder = createOrderBuilder({ currency: 'EUR', taxContext: { pricesIncludeTax: false, getTaxRatePpm: () => 0 } });
    builder.addLine({ productId: name, variantId: name, name, unitPrice: { amount: 1200, currency: 'EUR' } });
    builder.addPayment({ method: 'cash', amountMinor: 1200 });
    return { ...finalizeOrder(builder.getSnapshot()), syncStatus, ...extra };
  }
  function withSales(...recent: PosOrder[]) {
    vi.mocked(useOutboxContext).mockReturnValue({ ...useOutboxContext(), recent });
  }
  async function mount() {
    render(<SessionProvider><OrdersScreen /><PortalHost /></SessionProvider>);
    await act(async () => {});
  }
  const sold = () => sale('Blue shirt', 'applied', { cashierRef: 'ann@store.test', customer: { id: 'c1', name: 'Ada Lovelace' } });
  const openButton = (table: string, order: PosOrder) =>
    within(screen.getByTestId(`${table}-row-${order.id}`)).getByRole('button', { name: `Open order ${orderReference(order)}` });
  const refusal = "The online store refused this sale. Ask the store owner to look at the till's sync log.";
  // These are the table's tests; below 600 px Orders draws phone rows (row 10.5, below).
  beforeEach(() => { setWindowWidth(1024, 768); });

  it('a synced sale is only in the table, with v2\'s columns, its own words, and no notices or Retry', async () => {
    const order = sold();
    withSales(order);
    await mount();
    const table = within(screen.getByTestId('orders-table'));
    for (const label of ['Status', 'Order Number', 'Customer', 'Date Created', 'Cashier', 'Payment Method', 'Total']) {
      expect(table.getByText(label, { exact: true })).toBeTruthy();
    }
    const cell = (name: string) => screen.getByTestId(`orders-row-${order.id}-${name}`).textContent;
    expect(cell('status')).toBe('Completed');
    expect(cell('number')).toBe(orderReference(order));
    expect(cell('customer')).toBe('Ada Lovelace');
    expect(cell('date')).toBe(formatDate(order.createdAt));
    expect(cell('cashier')).toBe('ann@store.test');
    expect(cell('payment')).toBe('Cash');
    expect(cell('total')).toBe(formatMoney({ amount: order.totalMinor, currency: 'EUR' }));
    expect(screen.queryByText('Needs attention')).toBeNull();
    expect(screen.queryByTestId('orders-attention')).toBeNull();
    expect(screen.queryByTestId(`orders-row-${order.id}-notices`)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('pressing a row opens the sale\'s detail sheet', async () => {
    const order = sold();
    withSales(order);
    await mount();
    expect(screen.queryByTestId('order-detail-sheet')).toBeNull();
    fireEvent.click(openButton('orders', order));
    const sheet = within(await screen.findByTestId('order-detail-sheet'));
    expect(sheet.getAllByText(`Order ${orderReference(order)}`).length).toBeGreaterThan(0);
  });

  it('a refused sale is under attention with OrderSyncNotices\' refusal and Retry, which requeues once on a double press', async () => {
    const refused = sale('Red hat', 'rejected', { error: { code: 'platform_error', message: 'Refused' } });
    const applied = sale('Blue shirt', 'applied');
    withSales(refused, applied);
    let resolve: (count: number) => void = () => {};
    const requeue = vi.fn(() => new Promise<number>((done) => { resolve = done; }));
    vi.mocked(useOutboxContext).mockReturnValue({ ...useOutboxContext(), requeue });
    await mount();
    const attention = within(screen.getByTestId('orders-attention'));
    expect(attention.getByTestId(`orders-attention-row-${refused.id}`)).toBeTruthy();
    expect(screen.queryByTestId(`orders-attention-row-${applied.id}`)).toBeNull();
    expect(within(screen.getByTestId('orders-table')).getByTestId(`orders-row-${refused.id}`)).toBeTruthy();
    expect(within(screen.getByTestId('orders-table')).getByTestId(`orders-row-${applied.id}`)).toBeTruthy();
    const notices = within(attention.getByTestId(`orders-attention-row-${refused.id}-notices`));
    expect(notices.getByText(refusal)).toBeTruthy();
    // The notices are the attention table's alone: the all-orders table repeats neither the refusal nor Retry.
    expect(screen.getAllByText(refusal)).toHaveLength(1);
    expect(screen.queryByTestId(`orders-row-${refused.id}-notices`)).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(1);
    const retry = notices.getByRole('button', { name: 'Retry' });
    await act(async () => { fireEvent.click(retry); });
    await act(async () => { fireEvent.click(retry); });
    expect(requeue).toHaveBeenCalledExactlyOnceWith([refused.id]);
    expect(screen.queryByTestId('order-detail-sheet')).toBeNull();
    await act(async () => { resolve(1); });
  });

  it('two presses of Retry before React re-renders requeue the sale once', async () => {
    const refused = sale('Red hat', 'rejected', { error: { code: 'platform_error', message: 'Refused' } });
    withSales(refused);
    let resolve: (count: number) => void = () => {};
    const requeue = vi.fn(() => new Promise<number>((done) => { resolve = done; }));
    vi.mocked(useOutboxContext).mockReturnValue({ ...useOutboxContext(), requeue });
    await mount();
    const retry = screen.getByRole('button', { name: 'Retry' });
    // One act: the button is not yet disabled for the second press, so only the ref stops it.
    await act(async () => { fireEvent.click(retry); fireEvent.click(retry); });
    expect(requeue).toHaveBeenCalledExactlyOnceWith([refused.id]);
    await act(async () => { resolve(1); });
  });

  it.each([
    ['resolves 0', () => Promise.resolve(0)],
    ['rejects', () => Promise.reject(new Error('offline'))],
  ])('a Retry whose requeue %s leaves Retry enabled, and a second press requeues again', async (_, outcome) => {
    const refused = sale('Red hat', 'rejected', { error: { code: 'platform_error', message: 'Refused' } });
    withSales(refused);
    const requeue = vi.fn(outcome);
    vi.mocked(useOutboxContext).mockReturnValue({ ...useOutboxContext(), requeue });
    await mount();
    const retry = screen.getByRole('button', { name: 'Retry' });
    await act(async () => { fireEvent.click(retry); });
    expect(screen.getByRole('button', { name: 'Retry' }).getAttribute('aria-disabled')).not.toBe('true');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    expect(requeue).toHaveBeenCalledTimes(2);
    expect(requeue).toHaveBeenNthCalledWith(2, [refused.id]);
  });

  it('a refused sale the outbox cannot requeue is under attention with its notice and no Retry', async () => {
    const refused = sale('Red hat', 'rejected', { error: { code: 'idempotency_mismatch', message: 'Refused' } });
    withSales(refused);
    await mount();
    const notices = within(within(screen.getByTestId('orders-attention')).getByTestId(`orders-attention-row-${refused.id}-notices`));
    expect(notices.getByText("The online store has a different sale under this sale's number. Don't send it again; ask the store owner to compare the two."))
      .toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('a pending sale the outbox reports stuck is under attention, with the notices row\'s stuck-since line', async () => {
    const stuck = sale('Green scarf', 'pending');
    const waiting = sale('Blue shirt', 'pending');
    const firstFailedAt = new Date('2026-11-22T09:05:00').getTime();
    const entry = { commandId: stuck.commandId, since: firstFailedAt, firstFailedAt, reason: 'platform_error' };
    vi.mocked(useOutboxContext).mockReturnValue({
      ...useOutboxContext(), recent: [stuck, waiting], stuckCommandIds: [stuck.commandId],
      state: { pending: 2, sending: false, stuck: { commandIds: [stuck.commandId], since: firstFailedAt, firstFailedAt,
        reason: 'platform_error', orders: [entry] } },
    });
    await mount();
    const attention = within(screen.getByTestId('orders-attention'));
    expect(attention.getByTestId(`orders-attention-row-${stuck.id}`)).toBeTruthy();
    expect(screen.queryByTestId(`orders-attention-row-${waiting.id}`)).toBeNull();
    const since = new Date(firstFailedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    expect(within(attention.getByTestId(`orders-attention-row-${stuck.id}-notices`))
      .getByText(`Hasn't reached the online store since ${since}.`)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('Needs attention puts a day header before each day\'s stuck sales, and each notice stays under its sale', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(2026, 10, 25, 15, 0));
      const error = { code: 'platform_error', message: 'Refused' };
      const today = sale('Red hat', 'rejected', { error, createdAt: new Date(2026, 10, 25, 10, 0).toISOString() });
      const older = sale('Green scarf', 'rejected', { error, createdAt: new Date(2026, 10, 20, 10, 0).toISOString() });
      withSales(older, today);
      await mount();
      const attention = screen.getByTestId('orders-attention');
      const keep = ['day-2026-11-25', today.id, `${today.id}-notices`, 'day-2026-11-20', older.id, `${older.id}-notices`];
      const layout = Array.from(attention.querySelectorAll('[data-testid^="orders-attention-row-"]'),
        (element) => element.getAttribute('data-testid')!.replace('orders-attention-row-', '')).filter((id) => keep.includes(id));
      expect(layout).toEqual(keep);
      const heading = (day: string) => within(screen.getByTestId(`orders-attention-row-day-${day}`)).getByRole('heading').textContent;
      expect(heading('2026-11-25')).toBe('Today');
      expect(heading('2026-11-20')).toBe(new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(2026, 10, 20, 10, 0)));
    } finally { vi.useRealTimers(); }
  });

  it('opening a stuck pending sale from the all-sales table shows its stuck-since notice in the sheet', async () => {
    const stuck = sale('Green scarf', 'pending');
    const waiting = sale('Blue shirt', 'pending');
    const firstFailedAt = new Date('2026-11-22T09:05:00').getTime();
    const entry = { commandId: stuck.commandId, since: firstFailedAt, firstFailedAt, reason: 'platform_error' };
    vi.mocked(useOutboxContext).mockReturnValue({
      ...useOutboxContext(), recent: [stuck, waiting], stuckCommandIds: [stuck.commandId],
      state: { pending: 2, sending: false, stuck: { commandIds: [stuck.commandId], since: firstFailedAt, firstFailedAt,
        reason: 'platform_error', orders: [entry] } },
    });
    await mount();
    fireEvent.click(openButton('orders', stuck));
    expect((await screen.findByTestId('order-detail-notices')).textContent).toContain("Hasn't reached the online store since");
  });

  it('shows the empty state only when the search filters every sale out', async () => {
    withSales(sold());
    await mount();
    expect(screen.queryByTestId('orders-empty')).toBeNull();
    fireEvent.change(screen.getByTestId('orders-search'), { target: { value: 'no such sale' } });
    expect(screen.getByTestId('orders-empty').textContent).toBe('No orders match.');
    expect(screen.queryByTestId('orders-table')).toBeNull();
  });
});

describe('orders on a phone (row 10.5)', () => {
  function sale(name: string, syncStatus: PosOrder['syncStatus'], extra: Partial<PosOrder> = {}): PosOrder {
    const builder = createOrderBuilder({ currency: 'EUR', taxContext: { pricesIncludeTax: false, getTaxRatePpm: () => 0 } });
    builder.addLine({ productId: name, variantId: name, name, unitPrice: { amount: 1200, currency: 'EUR' } });
    builder.addPayment({ method: 'cash', amountMinor: 1200 });
    return { ...finalizeOrder(builder.getSnapshot()), syncStatus, ...extra };
  }
  async function mount(...recent: PosOrder[]) {
    vi.mocked(useOutboxContext).mockReturnValue({ ...useOutboxContext(), recent });
    render(<SessionProvider><OrdersScreen /><PortalHost /></SessionProvider>);
    await act(async () => {});
  }
  const heads = ['Status', 'Order Number', 'Customer', 'Billing Address', 'Date Created', 'Cashier', 'Payment Method', 'Total'];

  it('on a phone the Orders rows are two lines: number and total, then status, customer and date', async () => {
    setWindowWidth(390, 844);
    const order = sale('Blue shirt', 'applied', { cashierRef: 'ann@store.test', customer: { id: 'c1', name: 'Ada Lovelace' } });
    await mount(order);
    const table = within(screen.getByTestId('orders-table'));
    const row = screen.getByTestId(`orders-row-${order.id}`);
    const cell = (name: string) => screen.getByTestId(`orders-row-${order.id}-${name}`).textContent;
    expect(cell('number')).toBe(orderReference(order));
    expect(cell('total')).toBe(formatMoney({ amount: order.totalMinor, currency: 'EUR' }));
    expect(cell('status')).toBe('Completed');
    expect(cell('customer')).toBe('Ada Lovelace');
    expect(cell('date')).toBe(formatDate(order.createdAt));
    // No table head on a phone, and no Billing Address, Cashier or Payment Method: the detail sheet shows those.
    for (const head of heads) expect(table.queryByText(head, { exact: true })).toBeNull();
    for (const name of ['billing', 'cashier', 'payment']) expect(screen.queryByTestId(`orders-row-${order.id}-${name}`)).toBeNull();
    expect(row.textContent).not.toContain('ann@store.test');
    expect(row.textContent).not.toContain('Cash');
    expect(within(row).getByRole('button', { name: `Open order ${orderReference(order)}` })).toBeTruthy();

    act(() => { setWindowWidth(1024, 768); });
    const wide = within(screen.getByTestId('orders-table'));
    for (const head of heads) expect(wide.getByText(head, { exact: true })).toBeTruthy();
    expect(cell('cashier')).toBe('ann@store.test');
    expect(cell('payment')).toBe('Cash');
  });

  it('on a phone an attention row keeps its sync notice and Retry', async () => {
    setWindowWidth(390, 844);
    const refused = sale('Red hat', 'rejected', { error: { code: 'platform_error', message: 'Refused' } });
    let resolve: (count: number) => void = () => {};
    const requeue = vi.fn(() => new Promise<number>((done) => { resolve = done; }));
    vi.mocked(useOutboxContext).mockReturnValue({ ...useOutboxContext(), requeue });
    await mount(refused);
    const attention = within(screen.getByTestId('orders-attention'));
    expect(attention.queryByText('Billing Address', { exact: true })).toBeNull();
    const notices = within(attention.getByTestId(`orders-attention-row-${refused.id}-notices`));
    expect(notices.getByText("The online store refused this sale. Ask the store owner to look at the till's sync log.")).toBeTruthy();
    const retry = notices.getByRole('button', { name: 'Retry' });
    await act(async () => { fireEvent.click(retry); });
    await act(async () => { fireEvent.click(retry); });
    expect(requeue).toHaveBeenCalledExactlyOnceWith([refused.id]);
    expect(screen.queryByTestId('order-detail-sheet')).toBeNull();
    await act(async () => { resolve(1); });
  });

  it('on a phone the order detail shows the Billing Address and Cashier the row leaves out', async () => {
    setWindowWidth(390, 844);
    const order = sale('Blue shirt', 'applied', { cashierRef: 'ann@store.test',
      customer: { id: 'c1', name: 'Ada Lovelace', billing: { address1: 'Main St 5', city: 'Berlin', country: 'DE' } } });
    await mount(order);
    const row = screen.getByTestId(`orders-row-${order.id}`);
    expect(row.textContent).not.toContain('Main St 5');
    fireEvent.click(within(row).getByRole('button', { name: `Open order ${orderReference(order)}` }));
    const sheet = within(await screen.findByTestId('order-detail-sheet'));
    expect(sheet.getByTestId('order-detail-billing').textContent).toBe('Billing addressMain St 5, Berlin, DE');
    expect(sheet.getByTestId('order-detail-cashier').textContent).toBe('Cashierann@store.test');
  });
});
