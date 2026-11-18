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

const emptyText = 'No sales yet. Completed sales appear here.';

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
    requeue: vi.fn().mockResolvedValue(0), isStored: vi.fn().mockResolvedValue(false),
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

function mount() {
  render(<SessionProvider><OrdersScreen /></SessionProvider>);
}

describe('OrdersScreen', () => {
  it('shows TallyUI\'s single empty state when the till has no sales (#195, TallyUI 3.0.2)', () => {
    mount();
    expect(screen.getAllByText(emptyText)).toHaveLength(1);
    expect(screen.queryByText('No sales on this till yet. Completed sales show here.')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Send feedback' })).toBeNull();
  });

  it('hides the empty state once there is a sale (#195)', () => {
    const builder = createOrderBuilder({ currency: 'EUR', taxContext: { pricesIncludeTax: false, getTaxRatePpm: () => 0 } });
    builder.addLine({ productId: 'shirt', variantId: 'blue', name: 'Blue shirt', unitPrice: { amount: 1200, currency: 'EUR' } });
    builder.addPayment({ method: 'cash', amountMinor: 1200 });
    vi.mocked(useOutboxContext).mockReturnValue({ ...useOutboxContext(), recent: [finalizeOrder(builder.getSnapshot())] });
    mount();
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
  function mount() {
    render(<SessionProvider><OrdersScreen /><PortalHost /></SessionProvider>);
  }

  it('Open shows the sale in TallyUI\'s OrderDetail sheet, and Close removes it', async () => {
    const order = sale('Blue shirt', 'applied');
    withSales(order);
    mount();
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
    mount();
    fireEvent.click(screen.getByTestId(`order-open-${pending.id}`));
    expect(within(await screen.findByTestId('order-detail-sheet')).getByText('Pending')).toBeTruthy();
    fireEvent.click(screen.getByTestId('order-detail-close'));
    await waitFor(() => expect(screen.queryByTestId('order-detail-sheet')).toBeNull());
    fireEvent.click(screen.getAllByTestId(`order-open-${rejected.id}`)[0]!);
    expect(within(await screen.findByTestId('order-detail-sheet')).getByText('Cancelled')).toBeTruthy();
  });

  it('keeps Retry under Needs attention for a refused sale it can requeue', async () => {
    const rejected = sale('Blue shirt', 'rejected', { error: { code: 'platform_error', message: 'Refused' } });
    withSales(rejected);
    mount();
    expect(screen.getByText('Needs attention')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    expect(useOutboxContext().requeue).toHaveBeenCalledExactlyOnceWith([rejected.id]);
  });

  it('a search hides the other sale\'s Open button and an open sheet for a hidden sale stays open', async () => {
    const blue = sale('Blue shirt', 'applied');
    const red = sale('Red hat', 'applied');
    withSales(blue, red);
    mount();
    fireEvent.click(screen.getByTestId(`order-open-${red.id}`));
    expect(await screen.findByTestId('order-detail-sheet')).toBeTruthy();
    fireEvent.change(screen.getByTestId('orders-search'), { target: { value: 'blue' } });
    expect(screen.getByTestId(`order-open-${blue.id}`)).toBeTruthy();
    expect(screen.queryByTestId(`order-open-${red.id}`)).toBeNull();
    expect(within(screen.getByTestId('order-detail-sheet')).getByText('Red hat x1')).toBeTruthy();
  });
});
