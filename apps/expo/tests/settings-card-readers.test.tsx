// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveSession } from '../lib/session';
import { SessionProvider } from '../lib/session-context';
import SettingsScreen from '../app/settings';
import { setWindowWidth } from './window-width';

const { searchCustomers } = vi.hoisted(() => ({ searchCustomers: vi.fn().mockResolvedValue([]) }));
vi.mock('../lib/pos-connector', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/pos-connector')>(),
  createPosConnector: () => ({ id: 'medusa', searchCustomers }),
}));

// The phone opens one section per page, named by the route's `section` param.
const { params } = vi.hoisted(() => ({ params: {} as { section?: string } }));
vi.mock('expo-router', () => ({
  Redirect: ({ href }: { href: string }) => <span>redirect:{href}</span>,
  router: { replace: vi.fn(), navigate: vi.fn(), push: vi.fn(), dismissTo: vi.fn() }, usePathname: () => '/settings',
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
  saveSession(localStorage, {
    baseUrl, email: 'admin@store.test',
    token: `header.${btoa(JSON.stringify({ exp: Date.now() / 1000 + 86400 }))}.signature`,
  });
});

afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); act(() => setWindowWidth(0)); delete params.section; });

async function mount(children: ReactNode = <SettingsScreen />) {
  let view!: ReturnType<typeof render>;
  await act(async () => { view = render(<SessionProvider>{children}</SessionProvider>); });
  return view;
}

const follows = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe('Settings › Card readers', () => {
  it('on a wide window lists Card readers between Printing and Scanner and shows how cards are taken', async () => {
    setWindowWidth(1280, 800);
    await mount();
    const nav = screen.getByTestId('settings-nav-card-readers');
    expect(nav.textContent).toBe('Card readers');
    expect(follows(screen.getByTestId('settings-nav-printing'), nav)).toBe(true);
    expect(follows(nav, screen.getByTestId('settings-nav-scanner'))).toBe(true);
    expect(screen.queryByTestId('settings-card-readers')).toBeNull();
    fireEvent.click(nav);
    expect(screen.getByTestId('settings-card-readers')).toBeTruthy();
    expect(screen.getByTestId('settings-card-readers-method').textContent).toBe('Card terminal');
    expect(screen.getByTestId('settings-card-readers-capture').textContent).toBe('Separate card terminal');
    expect(screen.getByTestId('settings-card-readers-readers').textContent).toBe('None paired');
    const how = screen.getByTestId('settings-card-readers-how').textContent;
    expect(how).toContain('Terminal reference');
    expect(how).toContain('Card terminal');
    expect(screen.getByTestId('settings-nav-card-readers').getAttribute('aria-selected')).toBe('true');
  });

  it('on a phone lists Card readers between Printing and Scanner', async () => {
    setWindowWidth(0);
    await mount();
    const cardReaders = screen.getByTestId('settings-list-card-readers');
    expect(cardReaders.textContent).toBe('Card readers');
    expect(follows(screen.getByTestId('settings-list-printing'), cardReaders)).toBe(true);
    expect(follows(cardReaders, screen.getByTestId('settings-list-scanner'))).toBe(true);
  });
});
