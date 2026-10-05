// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Linking from 'expo-linking';
import { saveSession } from '../lib/session';
import { SessionProvider } from '../lib/session-context';
import { useOutboxContext } from '../lib/outbox-context';
import LoginScreen from '../app/login';
import OrdersScreen from '../app/orders';

vi.mock('expo-router', () => ({
  Redirect: ({ href }: { href: string }) => <span>redirect:{href}</span>,
  router: { replace: vi.fn(), push: vi.fn() },
  Stack: { Screen: () => null },
}));
vi.mock('expo-linking', () => ({ openURL: vi.fn().mockResolvedValue(true) }));
vi.mock('../lib/outbox-context', () => ({ useOutboxContext: vi.fn() }));

beforeEach(() => {
  vi.spyOn(window, 'open').mockImplementation(() => null);
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  });
  vi.mocked(useOutboxContext).mockReturnValue({
    orders: null, state: { pending: 0, sending: false }, recent: [], savesInFlight: 0, stuckCommandIds: [],
    record: vi.fn().mockResolvedValue(undefined), flush: vi.fn().mockResolvedValue(undefined), requeue: vi.fn().mockResolvedValue(0), isStored: vi.fn().mockResolvedValue(false),
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('Send feedback link', () => {
  it('on the web, Send feedback opens the issue form in a new tab and leaves the POS open', () => {
    render(<SessionProvider><LoginScreen /></SessionProvider>);
    fireEvent.click(screen.getByRole('link', { name: 'Send feedback' }));
    expect(window.open).toHaveBeenCalledWith(expect.stringContaining('https://github.com/medusapos/app/issues/new?'), '_blank', 'noopener,noreferrer');
    expect(Linking.openURL).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'Send feedback' })).toBeTruthy();
  });

  it('renders on the sign-in screen and opens the issue form with the typed backend URL', () => {
    render(<SessionProvider><LoginScreen /></SessionProvider>);
    fireEvent.change(screen.getByLabelText('Backend URL'), { target: { value: 'https://store.example.com' } });
    fireEvent.click(screen.getByRole('link', { name: 'Send feedback' }));
    expect(window.open).toHaveBeenCalledTimes(1);
    expect(window.open).toHaveBeenCalledWith(expect.any(String), '_blank', 'noopener,noreferrer');
    expect(Linking.openURL).not.toHaveBeenCalled();
    const openedUrl = vi.mocked(window.open).mock.calls[0][0];
    expect(openedUrl).toBeDefined();
    const url = new URL(String(openedUrl));
    expect(url.origin + url.pathname).toBe('https://github.com/medusapos/app/issues/new');
    expect(url.searchParams.get('template')).toBe('tester-feedback.yml');
    expect(url.searchParams.get('backend-host')).toBe('store.example.com');
  });

  it('renders on the Orders screen and opens the issue form with the signed-in backend host', () => {
    saveSession(localStorage, { baseUrl: 'https://signed-in.test', email: 'cashier@test.com', token: 'token' });
    render(<SessionProvider><OrdersScreen /></SessionProvider>);
    fireEvent.click(screen.getByRole('link', { name: 'Send feedback' }));
    expect(window.open).toHaveBeenCalledTimes(1);
    expect(window.open).toHaveBeenCalledWith(expect.any(String), '_blank', 'noopener,noreferrer');
    expect(Linking.openURL).not.toHaveBeenCalled();
    const openedUrl = vi.mocked(window.open).mock.calls[0][0];
    expect(openedUrl).toBeDefined();
    const url = new URL(String(openedUrl));
    expect(url.searchParams.get('backend-host')).toBe('signed-in.test');
  });
});
