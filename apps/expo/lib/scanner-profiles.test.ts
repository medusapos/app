// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import type { ScannerProfile } from '@tallyui/pos';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetScannerProfile, loadScannerProfiles, scannerProfileStoreFor, useScannerProfiles } from './scanner-profiles';

const KEY = 'medusapos.scanner-profiles';
const hid: ScannerProfile = { deviceKey: 'hid-pos:1504:4608', name: '', connectionType: 'hid-pos', deviceName: 'Test HID Scanner', vendorId: 1504, productId: 4608 };
const spp: ScannerProfile = { deviceKey: 'bluetooth-spp:00001101-0000-1000-8000-00805f9b34fb', name: '', connectionType: 'bluetooth-spp', deviceName: '' };

// A Map stub as the other storage tests use: jsdom's own localStorage is shadowed by Node's here (no --localstorage-file).
beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('scanner profiles', () => {
  it('upserts on deviceKey, and read filters by connection type unless the types are empty', async () => {
    const store = scannerProfileStoreFor(localStorage);
    await store.save(hid);
    await store.save(spp);
    await store.save({ ...hid, name: 'Front counter' });
    expect(loadScannerProfiles(localStorage)).toEqual([{ ...hid, name: 'Front counter' }, spp]);
    expect(await store.read(['hid-pos'])).toEqual([{ ...hid, name: 'Front counter' }]);
    expect(await store.read([])).toEqual([{ ...hid, name: 'Front counter' }, spp]);
  });

  it('reads a missing or corrupt value as the valid entries only, never throwing', () => {
    expect(loadScannerProfiles(localStorage)).toEqual([]);
    expect(loadScannerProfiles(null)).toEqual([]);
    for (const value of ['{', '{"a":1}', 'null', '"text"']) {
      localStorage.setItem(KEY, value);
      expect(loadScannerProfiles(localStorage)).toEqual([]);
    }
    localStorage.setItem(KEY, JSON.stringify([hid, null, 7, { deviceKey: 3, connectionType: 'hid-pos' },
      { deviceKey: 'x', connectionType: 'telepathy' }, { connectionType: 'hid-pos' }, spp]));
    expect(loadScannerProfiles(localStorage)).toEqual([hid, spp]);
  });

  it('forgets one profile, and useScannerProfiles re-renders after a save and after a forget', async () => {
    const store = scannerProfileStoreFor(localStorage);
    await store.save(spp);
    const { result } = renderHook(() => useScannerProfiles(localStorage));
    expect(result.current).toEqual([spp]);
    await act(async () => { await store.save(hid); });
    expect(result.current).toEqual([spp, hid]);
    act(() => { forgetScannerProfile(localStorage, spp.deviceKey); });
    expect(result.current).toEqual([hid]);
    expect(loadScannerProfiles(localStorage)).toEqual([hid]);
  });
});
