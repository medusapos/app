// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { router } from 'expo-router';
import { saveSession } from '../lib/session';
import { SessionProvider } from '../lib/session-context';
import SettingsScreen from '../app/settings';
import { AppFrame, useFrameAccountPublisher } from '../components/app-frame';
import { setWindowWidth } from './window-width';

const { searchCustomers } = vi.hoisted(() => ({ searchCustomers: vi.fn().mockResolvedValue([]) }));
vi.mock('../lib/pos-connector', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/pos-connector')>(),
  createPosConnector: () => ({ id: 'medusa', searchCustomers }),
}));

// The phone's section page is /settings?section=<id>; each test sets the screen's own params.
const { params } = vi.hoisted(() => ({ params: {} as { section?: string } }));
vi.mock('expo-router', () => ({
  Redirect: ({ href }: { href: string }) => <span>redirect:{href}</span>,
  router: { replace: vi.fn(), navigate: vi.fn(), push: vi.fn(), dismissTo: vi.fn(), back: vi.fn(), canGoBack: vi.fn(() => false) },
  usePathname: () => '/settings',
  useLocalSearchParams: () => params,
  Stack: { Screen: ({ options }: { options: { title?: string; headerShown?: boolean; headerLeft?: () => ReactNode; headerRight?: () => ReactNode } }) => <>
    <div data-testid="header-left" data-header-shown={String(options.headerShown)} data-title={options.title}>
      {options.headerLeft?.()}</div>
    <div data-testid="header-right">{options.headerRight?.()}</div>
  </> },
}));
vi.mock('expo-linking', () => ({ openURL: vi.fn().mockResolvedValue(true) }));

const SECTION_TEST_IDS = ['settings-store', 'settings-tax', 'settings-printing', 'settings-card-readers', 'settings-scanner',
  'settings-theme', 'settings-register', 'settings-danger'];

beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  });
  saveSession(localStorage, {
    baseUrl: 'https://store.test', email: 'admin@store.test',
    token: `header.${btoa(JSON.stringify({ exp: Date.now() / 1000 + 86400 }))}.signature`,
  });
});

afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); act(() => setWindowWidth(0)); delete params.section; });

async function mountFramed(width: number, height: number) {
  setWindowWidth(width, height);
  await act(async () => { render(<SessionProvider><AppFrame signedIn><SettingsScreen /></AppFrame></SessionProvider>); });
}

// The mocked Stack.Screen draws the header (its Menu button and avatar) in place, inside the list's ScrollView; skip it.
const listRows = () => within(screen.getByTestId('settings-list')).getAllByRole('button')
  .filter((row) => !screen.getByTestId('header-left').contains(row) && !screen.getByTestId('header-right').contains(row));

function AccountPublisher({ open }: { open: () => void }) {
  useFrameAccountPublisher({ displayName: 'Dana Cole', initials: 'DC', open });
  return null;
}

async function mountWithAccount(width: number, height: number, open: () => void) {
  setWindowWidth(width, height);
  await act(async () => {
    render(<SessionProvider><AppFrame signedIn><AccountPublisher open={open} /><SettingsScreen /></AppFrame></SessionProvider>);
  });
}

describe('Settings on a phone: a list of sections, each on its own page', () => {
  it('lists the wide nav\'s sections in its order, each with a chevron, under the frame\'s Menu and no section content', async () => {
    await mountFramed(1024, 768);
    const wideLabels = within(screen.getByTestId('settings-nav')).getAllByRole('button').map((item) => item.textContent);
    cleanup();
    await mountFramed(390, 844);
    expect(listRows().map((row) => row.textContent)).toEqual(wideLabels);
    expect(listRows().map((row) => row.getAttribute('aria-label'))).toEqual(wideLabels);
    expect(listRows().map((row) => row.dataset.testid)).toEqual(['settings-list-store', 'settings-list-tax', 'settings-list-printing',
      'settings-list-card-readers', 'settings-list-scanner', 'settings-list-theme', 'settings-list-register', 'settings-list-danger']);
    for (const row of listRows()) expect(within(row).getByTestId('settings-list-chevron').querySelector('svg')).toBeTruthy();
    expect(screen.getByRole('main', { name: 'Settings' }).contains(screen.getByTestId('settings-list'))).toBe(true);
    for (const id of SECTION_TEST_IDS) expect(screen.queryByTestId(id)).toBeNull();
    const headerLeft = screen.getByTestId('header-left');
    expect(headerLeft.dataset.title).toBe('Settings');
    expect(headerLeft.dataset.headerShown).toBe('true');
    expect(headerLeft.contains(screen.getByTestId('frame-menu'))).toBe(true);
    expect(screen.queryByTestId('settings-back')).toBeNull();
  });

  it('tapping Tax pushes the Tax section page', async () => {
    await mountFramed(390, 844);
    fireEvent.click(screen.getByTestId('settings-list-tax'));
    expect(router.push).toHaveBeenCalledExactlyOnceWith({ pathname: '/settings', params: { section: 'tax' } });
  });

  it('a section page shows only that section, titled with its label, behind a "‹ Settings" back control', async () => {
    params.section = 'tax';
    await mountFramed(390, 844);
    expect(screen.getByTestId('settings-tax')).toBeTruthy();
    for (const id of SECTION_TEST_IDS.filter((id) => id !== 'settings-tax')) expect(screen.queryByTestId(id)).toBeNull();
    expect(screen.queryByTestId('settings-list')).toBeNull();
    expect(screen.queryByTestId('settings-section-card')).toBeNull();
    expect(screen.queryByTestId('settings-section-title')).toBeNull();
    expect(screen.getByRole('main', { name: 'Settings' }).contains(screen.getByTestId('settings-tax'))).toBe(true);
    const headerLeft = screen.getByTestId('header-left');
    expect(headerLeft.dataset.title).toBe('Tax');
    expect(headerLeft.dataset.headerShown).toBe('true');
    const back = within(headerLeft).getByTestId('settings-back');
    expect(back.textContent).toBe('Settings');
    expect(back.getAttribute('aria-label')).toBe('Back to Settings');
    expect(within(headerLeft).queryByTestId('frame-menu')).toBeNull();
  });

  it('the back control goes back when there is a page under it, and replaces with the list when there is not', async () => {
    params.section = 'tax';
    await mountFramed(390, 844);
    vi.mocked(router.canGoBack).mockReturnValue(true);
    fireEvent.click(screen.getByTestId('settings-back'));
    expect(router.back).toHaveBeenCalledOnce();
    expect(router.replace).not.toHaveBeenCalled();
    vi.mocked(router.canGoBack).mockReturnValue(false);
    fireEvent.click(screen.getByTestId('settings-back'));
    expect(router.replace).toHaveBeenCalledExactlyOnceWith('/settings');
    expect(router.back).toHaveBeenCalledOnce();
  });

  it('an unknown section shows the list', async () => {
    params.section = 'nope';
    await mountFramed(390, 844);
    expect(listRows()).toHaveLength(8);
    for (const id of SECTION_TEST_IDS) expect(screen.queryByTestId(id)).toBeNull();
    expect(screen.getByTestId('header-left').dataset.title).toBe('Settings');
  });

  it('a wide window ignores the section param and shows the split layout on General', async () => {
    params.section = 'tax';
    await mountFramed(1024, 768);
    expect(screen.getByTestId('settings-nav')).toBeTruthy();
    expect(screen.getByTestId('settings-nav-store').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('settings-section-title').textContent).toBe('General');
    expect(screen.queryByTestId('settings-tax')).toBeNull();
    expect(screen.queryByTestId('settings-list')).toBeNull();
    expect(screen.queryByTestId('settings-back')).toBeNull();
  });
});

describe('Settings on a phone carries the account avatar at the top right, as v2 (row 14a)', () => {
  it('the list header and each section page header have the avatar as their right button, opening the account', async () => {
    const open = vi.fn();
    await mountWithAccount(390, 844, open);
    const avatar = screen.getByTestId('area-user-menu');
    expect(screen.getByTestId('header-right').contains(avatar)).toBe(true);
    expect(listRows()).not.toContain(avatar);
    expect(listRows()).toHaveLength(8);
    expect(screen.getByTestId('area-user-menu-avatar').textContent).toBe('DC');
    fireEvent.click(avatar);
    expect(open).toHaveBeenCalledOnce();
    cleanup();
    params.section = 'tax';
    await mountWithAccount(390, 844, open);
    expect(screen.getByTestId('settings-tax')).toBeTruthy();
    const sectionAvatar = screen.getByTestId('area-user-menu');
    expect(screen.getByTestId('header-right').contains(sectionAvatar)).toBe(true);
    fireEvent.click(sectionAvatar);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('a wide window has no avatar, and a phone has none until a Sale publishes the account', async () => {
    await mountWithAccount(1024, 768, vi.fn());
    expect(screen.getByTestId('settings-nav')).toBeTruthy();
    expect(screen.queryByTestId('area-user-menu')).toBeNull();
    cleanup();
    await mountFramed(390, 844);
    expect(screen.getByTestId('settings-list')).toBeTruthy();
    expect(screen.queryByTestId('area-user-menu')).toBeNull();
  });
});
