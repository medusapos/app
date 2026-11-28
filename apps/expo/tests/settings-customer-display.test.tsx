// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DisplaySignallingError } from '@tallyui/core';
import { createMemoryDisplaySignalling } from '@tallyui/core/server';
import { PortalHost } from '@tallyui/primitives';
import { Platform } from 'react-native';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import SettingsScreen from '../app/settings';
import { CustomerDisplayProvider } from '../lib/customer-display-context';
import { saveSession } from '../lib/session';
import { SessionProvider, useSession } from '../lib/session-context';
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
afterEach(() => { cleanup(); Platform.OS = platform; vi.useRealTimers(); vi.unstubAllGlobals(); setWindowWidth(0); });

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

it.each(['SX-1: live code', 'SX-2: expired code'])('%s stops polling after leaving the section and receiving an empty list', async (scenario) => {
  vi.useFakeTimers();
  const mint = vi.spyOn(memory.signalling, 'mint');
  let finishList!: (empty: []) => void;
  const list = vi.spyOn(memory.signalling, 'list').mockReturnValueOnce(new Promise((resolve) => { finishList = resolve; }));
  await mount(true);
  fireEvent.click(screen.getByTestId('settings-nav-customer-display'));
  fireEvent.click(screen.getByTestId('pairing-start'));
  await act(async () => {
    await vi.waitFor(() => expect(mint).toHaveBeenCalledOnce());
    await mint.mock.results[0].value;
  });
  const { code, expiresAt } = await mint.mock.results[0].value;
  expect(screen.getByTestId('pairing-code').textContent).toBe(code);
  if (scenario.startsWith('SX-2')) {
    await act(() => vi.advanceTimersByTimeAsync(Date.parse(expiresAt) - Date.now() + 1));
    await vi.waitFor(() => expect(screen.getByTestId('pairing-error').textContent).toMatch(/expired/i));
  }
  fireEvent.click(screen.getByTestId('settings-nav-store'));
  expect(list).toHaveBeenCalledOnce();
  await act(async () => finishList([]));
  list.mockClear();
  await act(() => vi.advanceTimersByTimeAsync(30000));
  expect(list).not.toHaveBeenCalled();
});

it('SX-3: leaving while confirming preserves the paired hint and polling', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('RTCPeerConnection', class {
    createDataChannel() { return { readyState: 'connecting', close() {} }; }
    createOffer() { return new Promise<never>(() => {}); }
    close() {}
  });
  const list = vi.spyOn(memory.signalling, 'list');
  const pending = vi.spyOn(memory.signalling, 'pending');
  const mint = vi.spyOn(memory.signalling, 'mint');
  const realConfirm = memory.signalling.confirm;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const confirm = vi.spyOn(memory.signalling, 'confirm').mockImplementation(async (...args) => { await gate; return realConfirm(...args); });
  await mount(true);
  fireEvent.click(screen.getByTestId('settings-nav-customer-display'));
  fireEvent.click(screen.getByTestId('pairing-start'));
  await act(async () => {
    await vi.waitFor(() => expect(mint).toHaveBeenCalledOnce());
    await Promise.all([mint.mock.results[0].value, list.mock.results[0].value]);
  });
  const code = screen.getByTestId('pairing-code').textContent!;
  await memory.signalling.claim(memory.harness.display('counter'), { code, displayName: 'Counter' });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
    await pending.mock.results[0].value;
  });
  fireEvent.click(screen.getByText('Confirm'));
  await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByTestId('settings-nav-store'));
  list.mockClear();
  await act(async () => {
    release();
    await confirm.mock.results[0].value;
    await vi.waitFor(() => expect(list).toHaveBeenCalled());
    await list.mock.results[0].value;
  });
  expect(localStorage.getItem('medusapos.display-paired.https://store.test')).toBe('1');
  list.mockClear();
  await act(() => vi.advanceTimersByTimeAsync(30000));
  expect(list).toHaveBeenCalled();
});

it('SX-4: leaving after a lost confirm response preserves the paired hint and polling', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('RTCPeerConnection', class {
    createDataChannel() { return { readyState: 'connecting', close() {} }; }
    createOffer() { return new Promise<never>(() => {}); }
    close() {}
  });
  const list = vi.spyOn(memory.signalling, 'list');
  const pending = vi.spyOn(memory.signalling, 'pending');
  const mint = vi.spyOn(memory.signalling, 'mint');
  const realConfirm = memory.signalling.confirm;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const confirm = vi.spyOn(memory.signalling, 'confirm').mockImplementation(async (...args) => {
    await gate;
    await realConfirm(...args);
    throw new DisplaySignallingError('network');
  });
  await mount(true);
  fireEvent.click(screen.getByTestId('settings-nav-customer-display'));
  fireEvent.click(screen.getByTestId('pairing-start'));
  await act(async () => {
    await vi.waitFor(() => expect(mint).toHaveBeenCalledOnce());
    await Promise.all([mint.mock.results[0].value, list.mock.results[0].value]);
  });
  const code = screen.getByTestId('pairing-code').textContent!;
  await memory.signalling.claim(memory.harness.display('counter'), { code, displayName: 'Counter' });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
    await pending.mock.results[0].value;
  });
  fireEvent.click(screen.getByText('Confirm'));
  await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce());
  await act(async () => {
    release();
    await expect(confirm.mock.results[0].value).rejects.toThrow(DisplaySignallingError);
  });
  await vi.waitFor(() => expect(screen.getByTestId('pairing-error')).toBeTruthy());
  fireEvent.click(screen.getByTestId('settings-nav-store'));
  expect(localStorage.getItem('medusapos.display-paired.https://store.test')).toBe('1');
  list.mockClear();
  await act(() => vi.advanceTimersByTimeAsync(30000));
  expect(list).toHaveBeenCalled();
});

it('SX-5: an expired code stays visible without polling until the cashier starts again', async () => {
  vi.useFakeTimers();
  const mint = vi.spyOn(memory.signalling, 'mint');
  const list = vi.spyOn(memory.signalling, 'list');
  await mount(true);
  fireEvent.click(screen.getByTestId('settings-nav-customer-display'));
  fireEvent.click(screen.getByTestId('pairing-start'));
  await vi.waitFor(() => expect(screen.getByTestId('pairing-code')).toBeTruthy());
  const { expiresAt } = await mint.mock.results[0].value;
  await act(() => vi.advanceTimersByTimeAsync(Date.parse(expiresAt) - Date.now() + 1));
  await vi.waitFor(() => expect(screen.getByTestId('pairing-error').textContent).toMatch(/expired/i));
  list.mockClear();
  await act(() => vi.advanceTimersByTimeAsync(30000));
  expect(list).not.toHaveBeenCalled();
  expect(localStorage.getItem('medusapos.display-paired.https://store.test')).toBe('0');
  fireEvent.click(screen.getByTestId('pairing-start'));
  await vi.waitFor(() => expect(screen.getByTestId('pairing-code')).toBeTruthy());
  fireEvent.click(screen.getByTestId('pairing-cancel'));
  await vi.waitFor(() => expect(screen.queryByTestId('pairing-code')).toBeNull());
  expect(screen.queryByTestId('pairing-error')).toBeNull();
});

it('SX-6: an expired code from before an advertisement change does not reappear after the last display is forgotten', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('RTCPeerConnection', class {
    createDataChannel() { return { readyState: 'connecting', close() {} }; }
    createOffer() { return new Promise<never>(() => {}); }
    close() {}
  });
  const mint = vi.spyOn(memory.signalling, 'mint');
  let mergeCapabilities!: ReturnType<typeof useSession>['mergeCapabilities'];
  function Probe() {
    mergeCapabilities = useSession().mergeCapabilities;
    return null;
  }
  saveSession(localStorage, { baseUrl: 'https://store.test', email: 'staff@example.test', token: 'jwt', tokenExpiresAt: Date.now() + 86400000,
    capabilities: { orderCreate: 7, customerDisplay: { iceServers: [], snapshot: true } } });
  await act(async () => { render(<SessionProvider><Probe /><CustomerDisplayProvider><SettingsScreen /></CustomerDisplayProvider><PortalHost /></SessionProvider>); });
  fireEvent.click(screen.getByTestId('settings-nav-customer-display'));
  fireEvent.click(screen.getByTestId('pairing-start'));
  await vi.waitFor(() => expect(screen.getByTestId('pairing-code')).toBeTruthy());
  const { code } = await mint.mock.results[0].value;
  await memory.signalling.claim(memory.harness.display('counter'), { code, displayName: 'Counter' });
  await act(() => vi.advanceTimersByTimeAsync(2000));
  await vi.waitFor(() => expect(screen.getByText('Confirm')).toBeTruthy());
  fireEvent.click(screen.getByText('Confirm'));
  await vi.waitFor(() => expect(screen.getByText('Counter')).toBeTruthy());

  fireEvent.click(screen.getByTestId('pairing-start'));
  await vi.waitFor(() => expect(screen.getByTestId('pairing-code')).toBeTruthy());
  const { expiresAt } = await mint.mock.results[1].value;
  await act(() => vi.advanceTimersByTimeAsync(Date.parse(expiresAt) - Date.now() + 1));
  await vi.waitFor(() => expect(screen.getByTestId('pairing-error').textContent).toMatch(/expired/i));

  act(() => mergeCapabilities({ orderCreate: 7, customerDisplay: { iceServers: [], snapshot: false } }));
  await vi.waitFor(() => expect(screen.queryByTestId('pairing-error')).toBeNull());
  await vi.waitFor(() => expect(screen.getByText('Forget')).toBeTruthy());
  fireEvent.click(screen.getByText('Forget'));
  fireEvent.click(screen.getByTestId(/^forget-confirm-/));
  await vi.waitFor(() => expect(localStorage.getItem('medusapos.display-paired.https://store.test')).toBe('0'));
  expect(screen.queryByTestId('pairing-error')).toBeNull();
});
