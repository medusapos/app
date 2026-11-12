// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { router } from 'expo-router';
import { createOrderBuilder, finalizeOrder } from '@tallyui/pos';
import { saveSession } from '../lib/session';
import { SessionProvider } from '../lib/session-context';
import { useOutboxContext } from '../lib/outbox-context';
import OrdersScreen from '../app/orders';
import { AppFrame } from '../components/app-frame';
import { setWindowWidth } from './window-width';

vi.mock('expo-router', () => ({
  Redirect: ({ href }: { href: string }) => <span>redirect:{href}</span>,
  router: { replace: vi.fn(), push: vi.fn(), dismissTo: vi.fn() }, usePathname: () => '/orders',
  Stack: { Screen: ({ options }: { options: { headerLeft?: () => ReactNode } }) =>
    <div data-testid="header-left">{options.headerLeft?.()}</div> },
}));
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
    expect(screen.getByRole('link', { name: 'Send feedback' })).toBeTruthy();
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
    expect(screen.getByTestId('header-left').contains(menu)).toBe(true);
    expect(within(screen.getByTestId('header-left')).getAllByRole('button')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Products' })).toBeNull();
    fireEvent.click(menu);
    fireEvent.click(within(screen.getByTestId('nav-drawer')).getByRole('button', { name: 'Sale' }));
    expect(router.dismissTo).toHaveBeenCalledExactlyOnceWith('/');
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('on a wide window the header has no back control; the rail stands in for it', () => {
    setWindowWidth(1440, 900);
    render(<SessionProvider><AppFrame signedIn><OrdersScreen /></AppFrame></SessionProvider>);
    expect(screen.getByTestId('header-left').childElementCount).toBe(0);
    expect(screen.getByTestId('nav-rail')).toBeTruthy();
  });
});
