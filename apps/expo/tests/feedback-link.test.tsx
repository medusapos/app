// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Linking from 'expo-linking';
import { saveSession } from '../lib/session';
import { SessionProvider } from '../lib/session-context';
import { useOutboxContext } from '../lib/outbox-context';
import LoginScreen from '../app/login';
import OrdersScreen from '../app/orders';
import SettingsScreen from '../app/settings';
import { version as appVersion } from '../package.json';

// The phone opens one section per page, named by the route's `section` param.
const { params } = vi.hoisted(() => ({ params: {} as { section?: string } }));
vi.mock('expo-router', () => ({
  Redirect: ({ href }: { href: string }) => <span>redirect:{href}</span>,
  router: { replace: vi.fn(), push: vi.fn() },
  useLocalSearchParams: () => params,
  Stack: { Screen: () => null },
}));
vi.mock('expo-linking', () => ({ openURL: vi.fn().mockResolvedValue(true) }));
// Settings' Danger zone imports the approval dialog, which reads the locale.
vi.mock('expo-localization', () => ({ getLocales: () => [{ languageTag: 'en-GB' }] }));
vi.mock('../lib/outbox-context', () => ({ useOutboxContext: vi.fn(), useOutboxOrders: vi.fn(() => null) }));

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
    record: vi.fn().mockResolvedValue(undefined), flush: vi.fn().mockResolvedValue(undefined), requeue: vi.fn().mockResolvedValue(0), discard: vi.fn(), cancelOnStore: vi.fn(), payRestOnStore: vi.fn(), reverseOnStore: vi.fn(), isStored: vi.fn().mockResolvedValue(false),
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  delete params.section;
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

  it('renders in Settings → General and opens the issue form with the signed-in backend host', async () => {
    saveSession(localStorage, { baseUrl: 'https://signed-in.test', email: 'cashier@test.com', token: 'token' });
    params.section = 'store';
    await act(async () => { render(<SessionProvider><SettingsScreen /></SessionProvider>); });
    fireEvent.click(screen.getByRole('link', { name: 'Send feedback' }));
    expect(window.open).toHaveBeenCalledTimes(1);
    expect(window.open).toHaveBeenCalledWith(expect.any(String), '_blank', 'noopener,noreferrer');
    expect(Linking.openURL).not.toHaveBeenCalled();
    const openedUrl = vi.mocked(window.open).mock.calls[0][0];
    expect(openedUrl).toBeDefined();
    const url = new URL(String(openedUrl));
    expect(url.origin + url.pathname).toBe('https://github.com/medusapos/app/issues/new');
    expect(url.searchParams.get('template')).toBe('tester-feedback.yml');
    expect(url.searchParams.get('backend-host')).toBe('signed-in.test');
    expect(url.searchParams.get('app-version')).toBe(appVersion);
  });

  it('is not drawn on the Orders screen', () => {
    saveSession(localStorage, { baseUrl: 'https://signed-in.test', email: 'cashier@test.com', token: 'token' });
    render(<SessionProvider><OrdersScreen /></SessionProvider>);
    expect(screen.queryByRole('link', { name: 'Send feedback' })).toBeNull();
  });
});
