// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { createMemoryDisplaySignalling } from '@tallyui/core/server';
import { useTillDisplays, useTillPairing } from '@tallyui/pos';
import type { ReactNode } from 'react';
import { Platform } from 'react-native';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CustomerDisplayProvider, useCustomerDisplay } from '../lib/customer-display-context';
import { REGISTER_ID_KEY, saveSession } from '../lib/session';
import { SessionProvider, useSession } from '../lib/session-context';

let memory: ReturnType<typeof createMemoryDisplaySignalling>;
let headers: Record<string, string>;
vi.mock('../lib/pos-connector', async (original) => ({ ...await original<typeof import('../lib/pos-connector')>(),
  authHeaders: () => headers, createPosConnector: () => ({ id: 'medusa', displaySignalling: memory.signalling }) }));
vi.mock('expo-localization', () => ({ getLocales: () => [{ languageTag: 'en' }] }));
const baseUrl = 'https://store.test';
const key = `medusapos.display-device-key.${baseUrl}`;
const platform = Platform.OS;
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto);
  sessionStorage.clear(); vi.stubGlobal('localStorage', sessionStorage);
  memory = createMemoryDisplaySignalling();
  headers = (await memory.harness.till({ cashierId: 'staff', canPair: true })).headers;
});
afterEach(() => { cleanup(); Platform.OS = platform; vi.useRealTimers(); vi.unstubAllGlobals(); });

function mount(advertised = true) {
  saveSession(localStorage, { baseUrl, token: 'jwt', email: 'staff@example.test', tokenExpiresAt: Date.now() + 86400000,
    capabilities: { orderCreate: 7, ...(advertised ? { customerDisplay: { snapshot: true, iceServers: [] } } : {}) } });
  const spies = (Object.keys(memory.signalling) as (keyof typeof memory.signalling)[]).map((method) => vi.spyOn(memory.signalling, method));
  const { result } = renderHook(() => {
    const display = useCustomerDisplay();
    return { ...display, displays: useTillDisplays(display.service), pairingView: useTillPairing(display.pairing), session: useSession() };
  }, { wrapper: ({ children }: { children: ReactNode }) => <SessionProvider><CustomerDisplayProvider>{children}</CustomerDisplayProvider></SessionProvider> });
  return { result, spies };
}

it.each([['C-1', 'ios', true], ['C-2', 'web', false]] as const)('%s: unavailable tills never signal', async (_, os, advertised) => {
  Platform.OS = os;
  const { result, spies } = mount(advertised);
  expect(result.current).toMatchObject({ available: false, service: null, pairing: null });
  await act(async () => result.current.startPairing());
  for (const spy of spies) expect(spy).not.toHaveBeenCalled();
});

it('C-3: an advertised but unpaired till does not poll', async () => {
  vi.useFakeTimers();
  const { result, spies } = mount();
  await act(() => vi.advanceTimersByTimeAsync(30000));
  expect(result.current).toMatchObject({ available: true, service: null, pairing: null, displays: { status: 'closed' } });
  for (const spy of spies) expect(spy).not.toHaveBeenCalled();
});

it('C-4: one start registers the device and shows a code', async () => {
  const { result } = mount();
  act(() => result.current.startPairing());
  await waitFor(() => expect(result.current.pairingView.phase.phase).toBe('code'));
  expect(localStorage.getItem(key)).toBeTruthy();
});

it.each(['C-6: advertisement loss', 'C-7: sign-out'])('C-5: a stored key activates the service; %s closes it', async (reason) => {
  const deviceId = 'register-1';
  const { deviceKey } = await memory.signalling.registerDevice({ connectorId: 'medusa', baseUrl, headers }, deviceId);
  localStorage.setItem(REGISTER_ID_KEY, deviceId); localStorage.setItem(key, deviceKey);
  const { result } = mount();
  expect(result.current.service).not.toBeNull();
  const close = vi.spyOn(result.current.service!, 'close');
  const closePairing = vi.spyOn(result.current.pairing!, 'close');
  await act(async () => reason.startsWith('C-6') ? result.current.session.mergeCapabilities({ orderCreate: 7 }) : result.current.session.signOut());
  expect(result.current).toMatchObject({ available: false, service: null, pairing: null });
  expect(close).toHaveBeenCalledOnce(); expect(closePairing).toHaveBeenCalledOnce();
});

it('C-8: the default context is inert', () => {
  const { result } = renderHook(useCustomerDisplay);
  expect(result.current).toEqual({ available: false, service: null, pairing: null, startPairing: expect.any(Function) });
  expect(result.current.startPairing()).toBeUndefined();
});
