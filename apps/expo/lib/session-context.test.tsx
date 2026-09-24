// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { Text } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { medusaConnector } from '@tallyui/connector-medusa';
import { clearProductCache } from './product-cache';
import { REFRESH_WINDOW_MS, saveSession, STORAGE_KEY, type Session } from './session';
import { SessionProvider, useSession } from './session-context';

vi.mock('./product-cache', () => ({ clearProductCache: vi.fn().mockResolvedValue(undefined) }));

const now = 1_800_000_000_000;
const token = (expires: number) => `header.${btoa(JSON.stringify({ exp: expires / 1000 }))}.signature`;
const stored: Session = { baseUrl: 'https://store.test', email: 'admin@store.test', token: token(now + 24 * 60 * 60 * 1000) };
let context: ReturnType<typeof useSession>;
let fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>;
let storage: { getItem: ReturnType<typeof vi.fn<Storage['getItem']>>; setItem: ReturnType<typeof vi.fn<Storage['setItem']>>; removeItem: ReturnType<typeof vi.fn<Storage['removeItem']>> };

function Probe() {
  context = useSession();
  return <Text>{context.session?.email ?? 'signed out'}</Text>;
}
async function mount(session: Session | null = stored) {
  if (session) saveSession(storage, session);
  await act(async () => { render(<SessionProvider><Probe /></SessionProvider>); });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const data = new Map<string, string>();
  storage = {
    getItem: vi.fn((key) => data.get(key) ?? null),
    setItem: vi.fn((key, value) => { data.set(key, value); }),
    removeItem: vi.fn((key) => { data.delete(key); }),
  };
  fetchImpl = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchImpl);
  vi.stubGlobal('localStorage', storage);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('SessionProvider', () => {
  it('restores a stored session without refreshing a far-expiry token', async () => {
    await mount();
    expect(screen.getByText(stored.email)).toBeTruthy();
    expect(context.session).toEqual(stored);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('refreshes a near-expiry token on mount and saves the replacement', async () => {
    const near = { ...stored, token: token(now + 1000) };
    fetchImpl.mockResolvedValue(new Response(JSON.stringify({ token: stored.token })));
    await mount(near);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledWith(`${stored.baseUrl}/auth/token/refresh`, {
      method: 'POST', headers: { Authorization: `Bearer ${near.token}` },
    });
    expect(context.session).toEqual(stored);
    expect(storage.getItem('medusapos.session')).toBe(JSON.stringify(stored));
  });
  it('signs out and clears storage and cache on a refresh 401', async () => {
    fetchImpl.mockResolvedValue(new Response('{}', { status: 401 }));
    await mount({ ...stored, token: token(now + 1000) });
    expect(screen.getByText('signed out')).toBeTruthy();
    expect(context.session).toBeNull();
    expect(storage.removeItem).toHaveBeenCalledWith('medusapos.session');
    expect(storage.getItem('medusapos.session')).toBeNull();
    expect(clearProductCache).toHaveBeenCalledWith(medusaConnector.id, stored.baseUrl);
  });
  it.each(['network', 'server'])('preserves the session on a refresh %s failure', async (failure) => {
    if (failure === 'network') fetchImpl.mockRejectedValue(new TypeError('offline'));
    else fetchImpl.mockResolvedValue(new Response('{}', { status: 500 }));
    const near = { ...stored, token: token(now + 1000) };
    await mount(near);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(screen.getByText(stored.email)).toBeTruthy();
    expect(context.session).toEqual(near);
    expect(storage.getItem('medusapos.session')).toBe(JSON.stringify(near));
    expect(storage.removeItem).not.toHaveBeenCalled();
    expect(clearProductCache).not.toHaveBeenCalled();
  });
  it('refreshes at the next five-minute check when a token enters the window', async () => {
    fetchImpl.mockResolvedValue(new Response(JSON.stringify({ token: stored.token })));
    await mount({ ...stored, token: token(now + REFRESH_WINDOW_MS + 60_000) });
    expect(fetchImpl).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000 - 1); });
    expect(fetchImpl).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(context.session).toEqual(stored);
  });
  it('updates the in-memory session (and its ref) when another tab signs in, refreshes or signs out', async () => {
    await mount(null);
    expect(context.session).toBeNull();
    const fromAnotherTab: Session = { ...stored, token: token(now + 24 * 60 * 60 * 1000) };
    saveSession(storage, fromAnotherTab);
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY, newValue: storage.getItem(STORAGE_KEY) })); });
    expect(context.session).toEqual(fromAnotherTab);

    const refreshed = { ...fromAnotherTab, token: token(now + 25 * 60 * 60 * 1000) };
    saveSession(storage, refreshed);
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY, newValue: storage.getItem(STORAGE_KEY) })); });
    expect(context.session).toEqual(refreshed);

    storage.removeItem(STORAGE_KEY);
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY, newValue: null })); });
    expect(context.session).toBeNull();

    // A storage event for an unrelated key is ignored.
    saveSession(storage, stored);
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: 'medusapos.register_id', newValue: 'other' })); });
    expect(context.session).toBeNull();
  });

  it.each(['signOut', 'reportUnauthorized'] as const)('%s clears state, storage and this backend cache', async (action) => {
    await mount();
    act(() => context[action]());
    expect(screen.getByText('signed out')).toBeTruthy();
    expect(context.session).toBeNull();
    expect(storage.removeItem).toHaveBeenCalledWith('medusapos.session');
    expect(storage.getItem('medusapos.session')).toBeNull();
    expect(clearProductCache).toHaveBeenCalledExactlyOnceWith(medusaConnector.id, stored.baseUrl);
  });
});
