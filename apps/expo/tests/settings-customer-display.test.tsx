// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryDisplaySignalling } from '@tallyui/core/server';
import { Platform } from 'react-native';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import SettingsScreen from '../app/settings';
import { CustomerDisplayProvider } from '../lib/customer-display-context';
import { saveSession } from '../lib/session';
import { SessionProvider } from '../lib/session-context';
import { setWindowWidth } from './window-width';

let memory: ReturnType<typeof createMemoryDisplaySignalling>;
let headers: Record<string, string>;
vi.mock('../lib/pos-connector', async (original) => ({ ...await original<typeof import('../lib/pos-connector')>(), authHeaders: () => headers,
  createPosConnector: () => ({ id: 'medusa', displaySignalling: memory.signalling, searchCustomers: vi.fn().mockResolvedValue([]) }) }));
vi.mock('expo-router', () => ({ Redirect: () => null, router: { push: vi.fn() }, usePathname: () => '/settings',
  useLocalSearchParams: () => ({}), Stack: { Screen: () => null } }));
vi.mock('expo-linking', () => ({ openURL: vi.fn().mockResolvedValue(true) }));
vi.mock('expo-localization', () => ({ getLocales: () => [{ languageTag: 'en-GB' }] }));

const platform = Platform.OS;
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })));
  sessionStorage.clear(); vi.stubGlobal('localStorage', sessionStorage);
  memory = createMemoryDisplaySignalling();
  headers = (await memory.harness.till({ cashierId: 'staff', canPair: true })).headers;
  setWindowWidth(1280, 800);
});
afterEach(() => { cleanup(); Platform.OS = platform; vi.unstubAllGlobals(); setWindowWidth(0); });

async function mount(advertised: boolean) {
  saveSession(localStorage, { baseUrl: 'https://store.test', email: 'staff@example.test', token: 'jwt', tokenExpiresAt: Date.now() + 86400000,
    capabilities: { orderCreate: 7, ...(advertised ? { customerDisplay: { iceServers: [], snapshot: true } } : {}) } });
  await act(async () => { render(<SessionProvider><CustomerDisplayProvider><SettingsScreen /></CustomerDisplayProvider></SessionProvider>); });
}

it('SC-1: Customer display follows Card readers and one press shows a pairing code', async () => {
  await mount(true);
  const nav = screen.getByTestId('settings-nav-customer-display');
  expect(nav.textContent).toBe('Customer display');
  expect(screen.getByTestId('settings-nav-card-readers').nextElementSibling).toBe(nav);
  fireEvent.click(nav);
  fireEvent.click(screen.getByTestId('pairing-start'));
  expect((await screen.findByTestId('pairing-code')).textContent).toMatch(/\S/);
});

it.each([['SC-2', 'web', false], ['SC-3', 'ios', true]] as const)('%s: no Customer display section', async (_, os, advertised) => {
  Platform.OS = os;
  await mount(advertised);
  expect(screen.getByTestId('settings-nav-card-readers')).toBeTruthy();
  expect(screen.queryByText('Customer display')).toBeNull();
});
