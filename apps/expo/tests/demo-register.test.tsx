// @vitest-environment jsdom
// D0: on the public demo every visitor is the same cashier, so each till gets its own register, bound by itself; a real
// store (and a demo-mode till signed in with an ordinary account, as e2e is) keeps Register 1 and the picker.
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { bindRegister } from '@tallyui/pos';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEMO_ACCOUNTS, demoRegisterFor } from '../lib/demo';
import { openOrderStore, registerCollections } from '../lib/order-store';
import { DEFAULT_REGISTERS, RegisterProvider, useRegister } from '../lib/register-context';
import { saveSession } from '../lib/session';
import { SessionProvider } from '../lib/session-context';

vi.mock('expo-localization', () => ({ getCalendars: () => [{ uses24hourClock: null }], getLocales: () => [{ languageTag: 'en-GB' }] }));
vi.mock('@tallyui/pos', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tallyui/pos')>();
  return { ...actual, bindRegister: vi.fn(actual.bindRegister) };
});

const DEVICE = '0190f3a2-7b1c-7d2e-9f30-a1b2c3d4e5f6';
const CASHIER = DEMO_ACCOUNTS[0].email;
let sequence = 0;
let baseUrl: string;
let store: Awaited<ReturnType<typeof openOrderStore>>;
let context: ReturnType<typeof useRegister>;
let seen: (string | null | undefined)[];

function Probe() {
  context = useRegister();
  seen.push(context.boundRegisterId);
  return null;
}

beforeEach(async () => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
  baseUrl = `https://demo-register-${++sequence}.test`;
  store = await openOrderStore(baseUrl);
  seen = [];
});
afterEach(async () => {
  cleanup();
  await store.close();
  vi.unstubAllGlobals();
  vi.mocked(bindRegister).mockClear();
});

async function mount({ demo, email = CASHIER, boundTo }: { demo: boolean; email?: string; boundTo?: { id: string; name: string } }) {
  if (boundTo) await bindRegister(registerCollections(store.orders).sessions, baseUrl, boundTo);
  vi.mocked(bindRegister).mockClear();
  saveSession(localStorage, { baseUrl, email,
    token: `header.${btoa(JSON.stringify({ exp: Date.now() / 1000 + 86400 }))}.signature` });
  await act(async () => {
    render(<SessionProvider><RegisterProvider orders={store.orders} deviceId={DEVICE} demo={demo}><Probe /></RegisterProvider></SessionProvider>);
  });
  await waitFor(() => expect(context.boundRegisterId).not.toBeUndefined());
  // Let any bind the provider started settle before the call counts are read.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
}

it('outside demo mode offers Register 1 and binds nothing by itself', async () => {
  await mount({ demo: false });
  expect(context.registers).toEqual(DEFAULT_REGISTERS);
  expect(context.boundRegisterId).toBeNull();
  expect(bindRegister).not.toHaveBeenCalled();
});

it('in demo mode an ordinary account (as e2e signs in) keeps Register 1 and the picker', async () => {
  await mount({ demo: true, email: 'admin@store.test' });
  expect(context.registers).toEqual(DEFAULT_REGISTERS);
  expect(context.boundRegisterId).toBeNull();
  expect(bindRegister).not.toHaveBeenCalled();
});

it('in demo mode an unbound till binds to its own register once, never showing the picker', async () => {
  const own = demoRegisterFor(DEVICE);
  await mount({ demo: true });
  expect(context.registers).toEqual([own]);
  expect(context.boundRegisterId).toBe(own.id);
  expect(context.registerName).toBe('Demo register');
  expect(bindRegister).toHaveBeenCalledOnce();
  expect(vi.mocked(bindRegister).mock.calls[0]?.slice(1)).toEqual([baseUrl, own]);
  expect(seen).not.toContain(null);
});

it('in demo mode a returning till still bound to Register 1 rebinds to its own and never reads Register 1', async () => {
  const own = demoRegisterFor(DEVICE);
  await mount({ demo: true, boundTo: DEFAULT_REGISTERS[0] });
  expect(context.registers).toEqual([own]);
  expect(context.boundRegisterId).toBe(own.id);
  expect(bindRegister).toHaveBeenCalledOnce();
  expect(vi.mocked(bindRegister).mock.calls[0]?.[2]).toEqual(own);
  expect(seen).not.toContain('register-1');
  expect(seen).not.toContain(null);
});

it('in demo mode a till already bound to its own register binds nothing', async () => {
  await mount({ demo: true, boundTo: demoRegisterFor(DEVICE) });
  expect(context.registers).toEqual([demoRegisterFor(DEVICE)]);
  expect(context.boundRegisterId).toBe(demoRegisterFor(DEVICE).id);
  expect(bindRegister).not.toHaveBeenCalled();
});

it('gives two tills two different register ids, the same on every call, within both bounds', () => {
  const [a, b] = [crypto.randomUUID(), crypto.randomUUID()];
  expect(demoRegisterFor(a).id).not.toBe(demoRegisterFor(b).id);
  expect(demoRegisterFor(a)).toEqual(demoRegisterFor(a));
  for (const id of [a, b, DEVICE].map((device) => demoRegisterFor(device).id)) {
    expect(id.startsWith('demo-')).toBe(true);
    // TallyUI's bindRegister bound is 36; the plugin's `...Id` bound is 64.
    expect(id.length).toBeLessThanOrEqual(36);
  }
});
