// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FontProvider } from '@tallyui/components';
import { AppText, useHeaderTitleStyle } from '../components/app-text';
import { AppFontProvider } from '../components/font-choice';
import { saveSession } from '../lib/session';
import { SessionProvider } from '../lib/session-context';
import SettingsScreen from '../app/settings';

vi.mock('expo-router', () => ({
  Redirect: ({ href }: { href: string }) => <span>redirect:{href}</span>,
  router: { replace: vi.fn(), navigate: vi.fn(), back: vi.fn(), canGoBack: vi.fn(() => false) },
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
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

async function mount(children: ReactNode = <SettingsScreen />) {
  let view!: ReturnType<typeof render>;
  await act(async () => { view = render(<SessionProvider>{children}</SessionProvider>); });
  return view;
}

const family = (testID: string) => screen.getByTestId(testID).style.fontFamily;

function HeaderProbe() {
  return <span data-testid="header-style">{JSON.stringify(useHeaderTitleStyle())}</span>;
}

describe('AppText', () => {
  it('takes Space Grotesk under the grotesk set', () => {
    render(<FontProvider font="grotesk"><AppText testID="t">Sale</AppText></FontProvider>);
    expect(family('t')).toContain('Space Grotesk');
  });

  it('has no family with no provider and under the system set', () => {
    render(<><AppText testID="bare">Sale</AppText><FontProvider font="system"><AppText testID="system">Sale</AppText></FontProvider></>);
    expect(family('bare')).toBe('');
    expect(family('system')).toBe('');
  });

  it('picks body, num for tabular-nums and none for font-mono under instrument', () => {
    render(<FontProvider font="instrument">
      <AppText testID="body">Sale</AppText>
      <AppText testID="num" className="text-sm tabular-nums">12.00</AppText>
      <AppText testID="mono" className="font-mono">SKU</AppText>
    </FontProvider>);
    expect(family('body')).toContain('DM Sans');
    expect(family('num')).toContain('JetBrains Mono');
    expect(family('mono')).toBe('');
  });

  it("lets the caller's fontFamily win over the set's", () => {
    render(<FontProvider font="grotesk"><AppText testID="t" style={{ fontFamily: 'Courier' }}>Sale</AppText></FontProvider>);
    expect(family('t')).toBe('Courier');
  });
});

describe('useHeaderTitleStyle', () => {
  it('is the 600 weight alone under system and adds the body face under grotesk', () => {
    render(<FontProvider font="system"><HeaderProbe /></FontProvider>);
    expect(screen.getByTestId('header-style').textContent).toBe('{"fontWeight":"600"}');
    cleanup();
    render(<FontProvider font="grotesk"><HeaderProbe /></FontProvider>);
    const style = JSON.parse(screen.getByTestId('header-style').textContent ?? '{}') as { fontWeight?: string; fontFamily?: string };
    expect(style.fontWeight).toBe('600');
    expect(style.fontFamily).toContain('Space Grotesk');
  });
});

describe('SettingsScreen in Space Grotesk', () => {
  it("draws the app's own Settings text in the chosen face once it has loaded", async () => {
    localStorage.setItem('medusapos.font', 'grotesk');
    await mount(<AppFontProvider><SettingsScreen /></AppFontProvider>);
    await waitFor(() => expect(family('settings-store-name')).toContain('Space Grotesk'));
  });
});
