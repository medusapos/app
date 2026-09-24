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
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  });
  vi.mocked(useOutboxContext).mockReturnValue({
    orders: null, state: { pending: 0, sending: false }, recent: [],
    record: vi.fn().mockResolvedValue(undefined), flush: vi.fn().mockResolvedValue(undefined), requeue: vi.fn().mockResolvedValue(0),
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('Send feedback link', () => {
  it('renders on the sign-in screen and opens the issue form with the typed backend URL', () => {
    render(<SessionProvider><LoginScreen /></SessionProvider>);
    fireEvent.change(screen.getByLabelText('Backend URL'), { target: { value: 'https://store.example.com' } });
    fireEvent.click(screen.getByRole('link', { name: 'Send feedback' }));
    expect(Linking.openURL).toHaveBeenCalledTimes(1);
    const url = new URL(vi.mocked(Linking.openURL).mock.calls[0][0]);
    expect(url.origin + url.pathname).toBe('https://github.com/medusapos/app/issues/new');
    expect(url.searchParams.get('template')).toBe('tester-feedback.yml');
    expect(url.searchParams.get('backend-host')).toBe('store.example.com');
  });

  it('renders on the Orders screen and opens the issue form with the signed-in backend host', () => {
    saveSession(localStorage, { baseUrl: 'https://signed-in.test', email: 'cashier@test.com', token: 'token' });
    render(<SessionProvider><OrdersScreen /></SessionProvider>);
    fireEvent.click(screen.getByRole('link', { name: 'Send feedback' }));
    expect(Linking.openURL).toHaveBeenCalledTimes(1);
    const url = new URL(vi.mocked(Linking.openURL).mock.calls[0][0]);
    expect(url.searchParams.get('backend-host')).toBe('signed-in.test');
  });
});
