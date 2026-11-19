// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveSession } from '../lib/session';
import { SessionProvider } from '../lib/session-context';
import { subscribeThemeChoice } from '../lib/theme-choice';
import SettingsScreen from '../app/settings';

// The phone opens one section per page, named by the route's `section` param.
const { params } = vi.hoisted(() => ({ params: {} as { section?: string } }));
vi.mock('expo-router', () => ({
  Redirect: ({ href }: { href: string }) => <span>redirect:{href}</span>,
  router: { replace: vi.fn(), navigate: vi.fn(), back: vi.fn(), canGoBack: vi.fn(() => false) },
  useLocalSearchParams: () => params,
  Stack: { Screen: ({ options }: { options: { headerLeft?: () => ReactNode; headerRight?: () => ReactNode } }) => <>
    <div data-testid="header-left">{options.headerLeft?.()}</div>
    {options.headerRight?.()}
  </> },
}));
vi.mock('expo-linking', () => ({ openURL: vi.fn().mockResolvedValue(true) }));
// Settings' Danger zone imports the approval dialog, which reads the locale.
vi.mock('expo-localization', () => ({ getLocales: () => [{ languageTag: 'en-GB' }] }));

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
  params.section = 'theme';
});

afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); delete params.section; });

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
    expect(screen.queryByTestId('settings-scanner')).toBeNull();
    cleanup();
    delete params.section;
    await mount();
    expect(screen.getByTestId('settings-list-scanner').compareDocumentPosition(screen.getByTestId('settings-list-theme')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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

  it('shows a tile with an icon and description for each of the ten themes, and pressing Ocean saves ocean', async () => {
    await mount();
    for (const label of ['Ocean', 'Sunset', 'Monochrome', 'Paper till', 'Warm shop', 'Bold money', 'Market stall']) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy();
    }
    // v2's descriptions, word for word.
    const descriptions: [string, string][] = [
      ['system', 'Follow your device settings'], ['light', 'Clean and bright'], ['dark', 'Easy on the eyes'],
      ['ocean', 'Cool blues and teals'], ['sunset', 'Warm oranges and purples'], ['monochrome', 'High contrast grayscale'],
      ['paper', 'Cream paper and ink'], ['warm', 'Warm neutrals and terracotta'], ['bold', 'Black, white and lime'],
      ['market', 'Coral, ink and pastel tiles'],
    ];
    for (const [id, description] of descriptions) {
      expect(screen.getByTestId(`theme-icon-${id}`)).toBeTruthy();
      expect(screen.getByTestId(`theme-description-${id}`).textContent).toBe(description);
    }
    expect(screen.queryByTestId('theme-swatch-ocean')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Ocean' }));
    expect(localStorage.getItem('medusapos.theme')).toBe('ocean');
    expect(screen.getByTestId('theme-tile-ocean').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('theme-tile-light').getAttribute('aria-selected')).toBe('false');
  });

  it('prints the current theme and follows a choice', async () => {
    await mount();
    expect(screen.getByTestId('settings-theme-current').textContent).toBe('Current Theme: Light');
    fireEvent.click(screen.getByRole('button', { name: 'Paper till' }));
    expect(screen.getByTestId('settings-theme-current').textContent).toBe('Current Theme: Paper till');
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
