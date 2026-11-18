// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFontType } from '@tallyui/components';
import { AppFontProvider } from '../components/font-choice';
import { saveSession } from '../lib/session';
import { SessionProvider } from '../lib/session-context';
import { chooseFont, FONT_CHOICES, FONT_LABELS, subscribeFontChoice } from '../lib/font-choice';
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

const baseUrl = 'https://store.test';

beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  });
  vi.stubGlobal('FontFace', class { async load() { return this; } });
  Object.defineProperty(document, 'fonts', { configurable: true, value: { add: vi.fn() } });
  saveSession(localStorage, {
    baseUrl, email: 'admin@store.test',
    token: `header.${btoa(JSON.stringify({ exp: Date.now() / 1000 + 86400 }))}.signature`,
  });
  params.section = 'theme';
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); delete params.section; });

async function mount(children: ReactNode = <SettingsScreen />) {
  let view!: ReturnType<typeof render>;
  await act(async () => { view = render(<SessionProvider>{children}</SessionProvider>); });
  return view;
}

function FontProbe() {
  const { setId, status, type } = useFontType();
  return <span>{setId} / {status} / {type.body ?? 'no body'}</span>;
}

describe('SettingsScreen Font section', () => {
  it('shows the five font radios after the theme tiles with System checked by default', async () => {
    await mount();
    expect(screen.getByText('Font')).toBeTruthy();
    expect(screen.getByText("The typeface this till's text uses. Saved on this till only.")).toBeTruthy();
    expect(screen.getByText('Current font: System')).toBeTruthy();
    expect(screen.getAllByRole('radio')).toHaveLength(5);
    for (const id of FONT_CHOICES) {
      expect(screen.getByRole('radio', { name: FONT_LABELS[id] })).toBeTruthy();
      expect(screen.getByTestId(`font-choice-${id}`).getAttribute('aria-checked')).toBe(String(id === 'system'));
    }
    expect(screen.getByTestId('settings-theme-choice').compareDocumentPosition(screen.getByTestId('settings-font')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows a stored Space Grotesk choice checked on open', async () => {
    localStorage.setItem('medusapos.font', 'grotesk');
    await mount();
    expect(screen.getByTestId('font-choice-grotesk').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('Current font: Space Grotesk')).toBeTruthy();
  });

  it('pressing Manrope saves and notifies once; pressing it again changes nothing', async () => {
    const listener = vi.fn(), unsubscribe = subscribeFontChoice(listener);
    try {
      await mount();
      const save = vi.spyOn(localStorage, 'setItem');
      fireEvent.click(screen.getByRole('radio', { name: 'Manrope' }));
      expect(save).toHaveBeenCalledExactlyOnceWith('medusapos.font', 'manrope');
      expect(localStorage.getItem('medusapos.font')).toBe('manrope');
      expect(listener).toHaveBeenCalledExactlyOnceWith('manrope');
      expect(screen.getByTestId('font-choice-manrope').getAttribute('aria-checked')).toBe('true');
      expect(screen.getByTestId('font-choice-system').getAttribute('aria-checked')).toBe('false');
      expect(screen.getByText('Current font: Manrope')).toBeTruthy();
      save.mockClear();
      listener.mockClear();
      fireEvent.click(screen.getByRole('radio', { name: 'Manrope' }));
      expect(save).not.toHaveBeenCalled();
      expect(listener).not.toHaveBeenCalled();
    } finally { unsubscribe(); }
  });

  it('previews Manrope in its own face and System without a family even with a font applied', async () => {
    localStorage.setItem('medusapos.font', 'grotesk');
    await mount(<AppFontProvider><SettingsScreen /><FontProbe /></AppFontProvider>);
    await screen.findByText('grotesk / loaded / Space Grotesk');
    expect(screen.getByTestId('font-preview-manrope').textContent).toBe('Aa');
    expect(screen.getByTestId('font-preview-manrope').style.fontFamily).toContain('Manrope');
    expect(screen.getByTestId('font-preview-system').textContent).toBe('Aa');
    expect(screen.getByTestId('font-preview-system').style.fontFamily).toBe('');
  });
});

describe('AppFontProvider', () => {
  it('loads the stored set app-wide and applies a later choice to mounted readers', async () => {
    localStorage.setItem('medusapos.font', 'grotesk');
    await mount(<AppFontProvider><FontProbe /></AppFontProvider>);
    expect(await screen.findByText('grotesk / loaded / Space Grotesk')).toBeTruthy();
    act(() => chooseFont(localStorage, 'fraunces'));
    await waitFor(() => expect(screen.getByText('fraunces / loaded / DM Sans')).toBeTruthy());
  });

  it('keeps system typography when FontFace is unavailable', async () => {
    vi.stubGlobal('FontFace', undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    localStorage.setItem('medusapos.font', 'grotesk');
    await mount(<AppFontProvider><FontProbe /></AppFontProvider>);
    expect(await screen.findByText('grotesk / failed / no body')).toBeTruthy();
  });
});
