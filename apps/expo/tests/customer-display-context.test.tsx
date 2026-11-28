// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { DisplaySignallingError } from '@tallyui/core';
import { createMemoryDisplaySignalling } from '@tallyui/core/server';
import { useTillDisplays, useTillPairing } from '@tallyui/pos';
import type { ReactNode } from 'react';
import { Platform } from 'react-native';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CustomerDisplayProvider, useCustomerDisplay } from '../lib/customer-display-context';
import { REGISTER_ID_KEY, saveSession } from '../lib/session';
import { SessionProvider, useSession } from '../lib/session-context';
import { advancePastExpiry } from './pairing-clock';

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
  expect(result.current).toEqual({ available: false, service: null, pairing: null, paired: false, startPairing: expect.any(Function) });
  expect(result.current.startPairing()).toBeUndefined();
});

const hint = `medusapos.display-paired.${baseUrl}`;
class NeverConnects {
  createDataChannel() { return { readyState: 'connecting', close() {} }; }
  createOffer() { return new Promise<never>(() => {}); }
  close() {}
}

async function storeDevice(deviceId = 'register-1') {
  const { deviceKey } = await memory.signalling.registerDevice({ connectorId: 'medusa', baseUrl, headers }, deviceId);
  localStorage.setItem(REGISTER_ID_KEY, deviceId);
  localStorage.setItem(key, deviceKey);
}

async function firstList() {
  const list = vi.mocked(memory.signalling.list);
  await act(async () => {
    await vi.waitFor(() => expect(list).toHaveBeenCalled());
    await list.mock.results[0].value;
  });
}

async function startWithCode() {
  const { result } = mount();
  act(() => result.current.startPairing());
  const pairing = result.current.pairing!;
  await act(async () => { await vi.waitFor(() => expect(pairing.phase.phase).toBe('code')); });
  return { result, pairing };
}

async function confirmDisplay() {
  vi.useFakeTimers();
  vi.stubGlobal('RTCPeerConnection', NeverConnects);
  const { result, pairing } = await startWithCode();
  const service = result.current.service!;
  const phase = pairing.phase;
  if (phase.phase !== 'code') throw Error('Expected pairing code');
  await memory.signalling.claim(memory.harness.display('counter'), { code: phase.code, displayName: 'Counter' });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
    await vi.mocked(memory.signalling.pending).mock.results[0].value;
  });
  const claims = pairing.phase;
  if (claims.phase !== 'code') throw Error('Expected pending claims');
  await act(() => pairing.confirm(claims.claims[0].claimId));
  return { result, pairing, service };
}

it('IT-1: an unpaired hint overrides the device key', async () => {
  vi.useFakeTimers();
  localStorage.setItem(key, 'stored-key'); localStorage.setItem(hint, '0');
  const { result, spies } = mount();
  await act(() => vi.advanceTimersByTimeAsync(30000));
  expect(result.current).toMatchObject({ service: null, pairing: null });
  for (const spy of spies) expect(spy).not.toHaveBeenCalled();
});

it('IT-2: an empty first list closes the service and pairing exactly once', async () => {
  vi.useFakeTimers();
  await storeDevice(); localStorage.setItem(hint, '1');
  const { result } = mount();
  const closeService = vi.spyOn(result.current.service!, 'close');
  const closePairing = vi.spyOn(result.current.pairing!, 'close');
  await firstList();
  expect(result.current).toMatchObject({ service: null, pairing: null });
  expect(localStorage.getItem(hint)).toBe('0');
  expect(closeService).toHaveBeenCalledOnce(); expect(closePairing).toHaveBeenCalledOnce();
  vi.mocked(memory.signalling.list).mockClear();
  await act(() => vi.advanceTimersByTimeAsync(30000));
  expect(memory.signalling.list).not.toHaveBeenCalled();
});

it('IT-3: cancelling an empty pairing stops polling', async () => {
  vi.useFakeTimers();
  const { result, pairing } = await startWithCode();
  await firstList();
  act(() => pairing.cancel());
  expect(result.current).toMatchObject({ service: null, pairing: null });
  expect(localStorage.getItem(hint)).toBe('0');
  vi.mocked(memory.signalling.list).mockClear();
  await act(() => vi.advanceTimersByTimeAsync(30000));
  expect(memory.signalling.list).not.toHaveBeenCalled();
});

it('IT-4: confirming a display keeps the same service polling', async () => {
  const { result, service } = await confirmDisplay();
  expect(localStorage.getItem(hint)).toBe('1');
  vi.mocked(memory.signalling.list).mockClear();
  await act(() => vi.advanceTimersByTimeAsync(30000));
  expect(memory.signalling.list).toHaveBeenCalled();
  expect(result.current.service).toBe(service);
});

it('IT-5: forgetting the last display returns the till to idle', async () => {
  const { result, pairing, service } = await confirmDisplay();
  await act(() => pairing.forget(service.displays[0].display.displayId));
  expect(result.current).toMatchObject({ service: null, pairing: null });
  expect(localStorage.getItem(hint)).toBe('0');
});

it('IT-6: a session render during key replacement keeps the paired service', async () => {
  vi.stubGlobal('RTCPeerConnection', NeverConnects);
  await memory.harness.seedLegacyDevice('paired-till');
  await storeDevice('paired-till'); localStorage.setItem(hint, '1');
  const { result } = mount();
  await firstList();
  const service = result.current.service!;
  expect(service.displays).toHaveLength(1);
  const close = vi.spyOn(service, 'close');
  localStorage.removeItem(key);
  act(() => result.current.session.mergeCapabilities({ ...result.current.session.session?.capabilities, orderCreate: 6 }));
  expect(result.current.session.session?.capabilities?.orderCreate).toBe(6);
  expect(result.current.service).toBe(service);
  expect(close).not.toHaveBeenCalled();
});

it('IT-7: failed lists keep the hint and service active', async () => {
  vi.useFakeTimers();
  await storeDevice(); localStorage.setItem(hint, '1');
  const { result } = mount();
  vi.mocked(memory.signalling.list).mockRejectedValue(new DisplaySignallingError('network'));
  await act(() => vi.advanceTimersByTimeAsync(30000));
  expect(memory.signalling.list).toHaveBeenCalled();
  expect(result.current.service?.status).toBe('offline');
  expect(localStorage.getItem(hint)).toBe('1');
});

it('IT-8: a refused start leaves its pairing error visible', async () => {
  const { result, pairing } = await startWithCode();
  await firstList();
  headers = (await memory.harness.till({ cashierId: 'viewer', canPair: false })).headers;
  act(() => result.current.startPairing());
  await waitFor(() => expect(result.current.pairingView.phase).toEqual({ phase: 'idle', error: 'forbidden' }));
  expect(result.current.pairing).toBe(pairing);
  expect(localStorage.getItem(hint)).toBeNull();
});

it('IT-9: cancelling before the first list resolves preserves the paired hint', async () => {
  await storeDevice(); localStorage.setItem(hint, '1');
  const { result } = mount();
  let finishList!: (empty: []) => void;
  vi.mocked(memory.signalling.list).mockReturnValueOnce(new Promise((resolve) => { finishList = resolve; }));
  await waitFor(() => expect(memory.signalling.list).toHaveBeenCalledOnce());
  const service = result.current.service!;
  act(() => result.current.startPairing());
  act(() => result.current.pairing!.cancel());
  expect(result.current.service).toBe(service);
  expect(localStorage.getItem(hint)).toBe('1');
  await act(async () => finishList([]));
  expect(result.current.service).toBeNull();
});

it('IT-10: a confirmed display stays active across reload when lists fail', async () => {
  await storeDevice(); localStorage.setItem(hint, '0');
  vi.spyOn(memory.signalling, 'list').mockRejectedValue(new DisplaySignallingError('network'));
  const { result, pairing } = await confirmDisplay();
  expect(pairing.phase).toEqual({ phase: 'idle' });
  expect(localStorage.getItem(hint)).toBe('1');
  expect(result.current.service).not.toBeNull();
  expect(result.current.service?.status).toBe('offline');
  cleanup();
  expect(mount().result.current.service).not.toBeNull();
});

it('IT-11: an expired code with no displays stops polling', async () => {
  vi.useFakeTimers();
  const { result, pairing } = await startWithCode();
  await firstList();
  const { phase } = pairing;
  if (phase.phase !== 'code') throw Error('Expected pairing code');
  await advancePastExpiry(phase.expiresAt, vi.mocked(memory.signalling.pending));
  expect(result.current).toMatchObject({ service: null, pairing: null });
  expect(localStorage.getItem(hint)).toBe('0');
  vi.mocked(memory.signalling.list).mockClear();
  await act(() => vi.advanceTimersByTimeAsync(30000));
  expect(memory.signalling.list).not.toHaveBeenCalled();
});
