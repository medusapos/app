// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveSession } from '../lib/session';
import { SessionProvider } from '../lib/session-context';
import { subscribeThemeChoice } from '../lib/theme-choice';
import SettingsScreen from '../app/settings';

vi.mock('expo-router', () => ({
  Redirect: ({ href }: { href: string }) => <span>redirect:{href}</span>,
  router: { replace: vi.fn(), navigate: vi.fn(), back: vi.fn(), canGoBack: vi.fn(() => false) },
  Stack: { Screen: ({ options }: { options: { headerLeft?: () => ReactNode; headerRight?: () => ReactNode } }) => <>
    <div data-testid="header-left">{options.headerLeft?.()}</div>
    {options.headerRight?.()}
  </> },
}));

const baseUrl = 'https://store.test';

beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  });
  saveSession(localStorage, {
    baseUrl, email: 'admin@store.test',
    token: `header.${btoa(JSON.stringify({ exp: Date.now() / 1000 + 86400 }))}.signature`,
  });
});

afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

async function mount(children: ReactNode = <SettingsScreen />) {
  let view!: ReturnType<typeof render>;
  await act(async () => { view = render(<SessionProvider>{children}</SessionProvider>); });
  return view;
}

describe('SettingsScreen Theme section', () => {
  it('shows a Theme section after Scanner with System, Light and Dark, Light pressed by default', async () => {
    await mount();
    expect(screen.getByText('Theme')).toBeTruthy();
    expect(screen.getByText("Light, dark, follow this device's setting, or a colour theme. Saved on this till only.")).toBeTruthy();
    for (const label of ['System', 'Light', 'Dark']) expect(screen.getByRole('button', { name: label })).toBeTruthy();
    expect(screen.getByTestId('theme-tile-light').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('theme-tile-system').getAttribute('aria-selected')).toBe('false');
    expect(screen.getByTestId('theme-tile-dark').getAttribute('aria-selected')).toBe('false');
    expect(screen.getByTestId('settings-scanner').compareDocumentPosition(screen.getByTestId('settings-theme')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('a stored choice shows pressed on open', async () => {
    localStorage.setItem('medusapos.theme', 'system');
    await mount();
    expect(screen.getByTestId('theme-tile-system').getAttribute('aria-selected')).toBe('true');
  });

  it('pressing Dark saves dark under medusapos.theme, presses Dark and tells subscribers', async () => {
    const listener = vi.fn(), unsubscribe = subscribeThemeChoice(listener);
    try {
      await mount();
      fireEvent.click(screen.getByRole('button', { name: 'Dark' }));
      expect(localStorage.getItem('medusapos.theme')).toBe('dark');
      expect(listener).toHaveBeenCalledExactlyOnceWith('dark');
      expect(screen.getByTestId('theme-tile-dark').getAttribute('aria-selected')).toBe('true');
      expect(screen.getByTestId('theme-tile-light').getAttribute('aria-selected')).toBe('false');
    } finally { unsubscribe(); }
  });

  it('shows a tile with a swatch for each of the ten themes, and pressing Ocean saves ocean', async () => {
    await mount();
    for (const label of ['Ocean', 'Sunset', 'Monochrome', 'Paper till', 'Warm shop', 'Bold money', 'Market stall']) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy();
    }
    expect(screen.getByTestId('theme-swatch-ocean')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Ocean' }));
    expect(localStorage.getItem('medusapos.theme')).toBe('ocean');
    expect(screen.getByTestId('theme-tile-ocean').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('theme-tile-light').getAttribute('aria-selected')).toBe('false');
  });

  it('pressing the pressed choice again changes nothing', async () => {
    const listener = vi.fn(), unsubscribe = subscribeThemeChoice(listener);
    try {
      await mount();
      fireEvent.click(screen.getByRole('button', { name: 'Light' }));
      expect(localStorage.getItem('medusapos.theme')).toBeNull();
      expect(listener).not.toHaveBeenCalled();
      expect(screen.getByTestId('theme-tile-light').getAttribute('aria-selected')).toBe('true');
    } finally { unsubscribe(); }
  });
});
