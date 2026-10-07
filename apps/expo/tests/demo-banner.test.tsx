// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DemoBanner } from '../components/demo-banner';
import { isDemoMode, storeConfig } from '../lib/config';
import { saveSession } from '../lib/session';
import { SessionProvider } from '../lib/session-context';

vi.mock('expo-linking', () => ({ openURL: vi.fn().mockResolvedValue(true) }));

const originalDemoMode = storeConfig.demo;
beforeEach(() => {
  storeConfig.demo = true;
  vi.spyOn(window, 'open').mockImplementation(() => null);
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  });
});
afterEach(() => {
  cleanup();
  storeConfig.demo = originalDemoMode;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('Demo banner', () => {
  it('shows exactly three links for a demo account and opens them in order', () => {
    saveSession(localStorage, { baseUrl: 'https://demo.test', email: 'cashier@demo.medusapos.com', token: 'token' });
    render(<SessionProvider><DemoBanner /></SessionProvider>);
    expect(screen.getByTestId('demo-banner')).toBeTruthy();
    fireEvent.click(screen.getByTestId('demo-banner-site'));
    fireEvent.click(screen.getByTestId('demo-banner-quick-start'));
    fireEvent.click(screen.getByTestId('demo-banner-github'));
    expect(window.open).toHaveBeenNthCalledWith(1, 'https://medusapos.com', '_blank', 'noopener,noreferrer');
    expect(window.open).toHaveBeenNthCalledWith(2, 'https://medusapos.com/docs/quick-start', '_blank', 'noopener,noreferrer');
    expect(window.open).toHaveBeenNthCalledWith(3, 'https://github.com/medusapos/app', '_blank', 'noopener,noreferrer');
    expect(window.open).toHaveBeenCalledTimes(3);
    expect(within(screen.getByTestId('demo-banner')).getAllByRole('link')).toHaveLength(3);
  });

  it('disappears when dismissed', () => {
    saveSession(localStorage, { baseUrl: 'https://demo.test', email: 'cashier@demo.medusapos.com', token: 'token' });
    render(<SessionProvider><DemoBanner /></SessionProvider>);
    fireEvent.click(screen.getByTestId('demo-banner-dismiss'));
    expect(screen.queryByTestId('demo-banner')).toBeNull();
  });

  it('is hidden on app.medusapos.com even for a demo account', () => {
    storeConfig.demo = isDemoMode(undefined, 'app.medusapos.com');
    saveSession(localStorage, { baseUrl: 'https://demo.test', email: 'cashier@demo.medusapos.com', token: 'token' });
    render(<SessionProvider><DemoBanner /></SessionProvider>);
    expect(screen.queryByTestId('demo-banner')).toBeNull();
  });

  it('is hidden for a non-demo account in demo mode', () => {
    saveSession(localStorage, { baseUrl: 'https://demo.test', email: 'e2e@tally.test', token: 'token' });
    render(<SessionProvider><DemoBanner /></SessionProvider>);
    expect(screen.queryByTestId('demo-banner')).toBeNull();
  });

  it('is hidden without a saved session in demo mode', () => {
    render(<SessionProvider><DemoBanner /></SessionProvider>);
    expect(screen.queryByTestId('demo-banner')).toBeNull();
  });
});
