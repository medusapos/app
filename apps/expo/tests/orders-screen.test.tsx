// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { router } from 'expo-router';
import { createOrderBuilder, finalizeOrder } from '@tallyui/pos';
import { saveSession } from '../lib/session';
import { SessionProvider } from '../lib/session-context';
import { useOutboxContext } from '../lib/outbox-context';
import OrdersScreen from '../app/orders';

vi.mock('expo-router', () => ({
  Redirect: ({ href }: { href: string }) => <span>redirect:{href}</span>,
  router: { replace: vi.fn(), back: vi.fn(), canGoBack: vi.fn(() => false) },
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

  it('has one Products back control in the header that goes back when there is history, else replaces to / (#195)', () => {
    mount();
    const products = screen.getAllByRole('button', { name: 'Products' });
    expect(products).toHaveLength(1);
    expect(screen.getByTestId('header-left').contains(products[0])).toBe(true);
    vi.mocked(router.canGoBack).mockReturnValueOnce(true);
    fireEvent.click(products[0]);
    expect(router.back).toHaveBeenCalledTimes(1);
    expect(router.replace).not.toHaveBeenCalled();
    fireEvent.click(products[0]);
    expect(router.replace).toHaveBeenCalledWith('/');
    expect(router.back).toHaveBeenCalledTimes(1);
  });
});
