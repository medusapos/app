// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCALE_VARIABLE_NAMES } from '@tallyui/theme';
import { AppScale } from '../components/app-scale';
import { saveSession } from '../lib/session';
import { SessionProvider } from '../lib/session-context';
import { subscribeScaleChoice } from '../lib/scale-choice';
import SettingsScreen from '../app/settings';
import { setWindowWidth } from './window-width';

vi.mock('expo-router', () => ({
  Redirect: ({ href }: { href: string }) => <span>redirect:{href}</span>,
  router: { replace: vi.fn(), navigate: vi.fn(), back: vi.fn(), canGoBack: vi.fn(() => false) },
  Stack: { Screen: ({ options }: { options: { headerLeft?: () => ReactNode; headerRight?: () => ReactNode } }) => <>
    <div data-testid="header-left">{options.headerLeft?.()}</div>
    {options.headerRight?.()}
  </> },
}));

beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => { data.set(key, value); }),
    removeItem: (key: string) => { data.delete(key); },
  });
  saveSession(localStorage, {
    baseUrl: 'https://store.test', email: 'admin@store.test',
    token: `header.${btoa(JSON.stringify({ exp: Date.now() / 1000 + 86400 }))}.signature`,
  });
});

afterEach(() => {
  cleanup();
  setWindowWidth(0, 0);
  vi.clearAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

async function mount() {
  await act(async () => { render(<SessionProvider><AppScale><SettingsScreen /></AppScale></SessionProvider>); });
}

describe('SettingsScreen Scale choice', () => {
  it('shows four choices inside Theme, with Regular pressed by default at phone width', async () => {
    await mount();
    const block = screen.getByTestId('settings-scale');
    expect(screen.getByTestId('settings-theme').contains(block)).toBe(true);
    expect(within(block).getByText('Scale')).toBeTruthy();
    expect(within(block).getByText('Auto follows the window size. Saved on this till only.')).toBeTruthy();
    const group = within(block).getByRole('group', { name: 'Scale' });
    expect(within(group).getAllByRole('button').map((button) => button.textContent)).toEqual(['Auto', 'Compact', 'Regular', 'Spacious']);
    for (const label of ['Auto', 'Compact', 'Regular', 'Spacious']) {
      expect(within(group).getByRole('button', { name: label }).getAttribute('aria-pressed')).toBe(String(label === 'Regular'));
    }
    expect(document.documentElement.style.getPropertyValue('--text-base')).toBe('14px');
    expect(document.documentElement.style.getPropertyValue('--spacing')).toBe('4px');
    expect(within(block).getByTestId('settings-scale-current').textContent).toBe('Current scale: Regular');
    fireEvent.click(within(group).getByRole('button', { name: 'Compact' }));
    expect(within(block).getByTestId('settings-scale-current').textContent).toBe('Current scale: Compact');
  });

  it('applies and stores Compact, Auto and Spacious app-wide', async () => {
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Compact' }));
    expect(localStorage.getItem('medusapos.scale')).toBe('compact');
    expect(screen.getByTestId('scale-choice-compact').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('scale-choice-regular').getAttribute('aria-pressed')).toBe('false');
    expect(document.documentElement.style.getPropertyValue('--text-base')).toBe('13px');
    expect(document.documentElement.style.getPropertyValue('--spacing')).toBe('3.5px');
    fireEvent.click(screen.getByRole('button', { name: 'Auto' }));
    expect(localStorage.getItem('medusapos.scale')).toBe('auto');
    expect(document.documentElement.style.getPropertyValue('--text-base')).toBe('13px');
    fireEvent.click(screen.getByRole('button', { name: 'Spacious' }));
    expect(document.documentElement.style.getPropertyValue('--text-base')).toBe('16px');
    expect(document.documentElement.style.getPropertyValue('--spacing')).toBe('5px');
  });

  it('Auto resolves to regular in the wide split layout', async () => {
    setWindowWidth(1024, 768);
    localStorage.setItem('medusapos.scale', 'auto');
    await mount();
    fireEvent.click(screen.getByTestId('settings-nav-theme'));
    expect(screen.getByTestId('scale-choice-auto').getAttribute('aria-pressed')).toBe('true');
    expect(document.documentElement.style.getPropertyValue('--text-base')).toBe('14px');
  });

  it('a stored Spacious choice is pressed on open', async () => {
    localStorage.setItem('medusapos.scale', 'spacious');
    await mount();
    expect(screen.getByTestId('scale-choice-spacious').getAttribute('aria-pressed')).toBe('true');
    expect(document.documentElement.style.getPropertyValue('--text-base')).toBe('16px');
    expect(screen.getByTestId('settings-scale-current').textContent).toBe('Current scale: Spacious');
  });

  it('pressing the pressed Regular writes nothing and notifies nobody', async () => {
    const listener = vi.fn(), unsubscribe = subscribeScaleChoice(listener);
    try {
      await mount();
      vi.mocked(localStorage.setItem).mockClear();
      fireEvent.click(screen.getByRole('button', { name: 'Regular' }));
      expect(localStorage.setItem).not.toHaveBeenCalled();
      expect(localStorage.getItem('medusapos.scale')).toBeNull();
      expect(listener).not.toHaveBeenCalled();
      expect(screen.getByTestId('scale-choice-regular').getAttribute('aria-pressed')).toBe('true');
    } finally { unsubscribe(); }
  });

  it('removes all root scale variables on cleanup', async () => {
    await mount();
    cleanup();
    for (const name of SCALE_VARIABLE_NAMES) expect(document.documentElement.style.getPropertyValue(name)).toBe('');
  });
});
