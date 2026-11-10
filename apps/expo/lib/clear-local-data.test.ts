import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLEAR_FLAG_KEY, clearAllLocalData, clearWarnings, isClearPending, requestClearLocalData,
} from './clear-local-data';

function fakeStorage(entries: Record<string, string> = {}) {
  const data = new Map(Object.entries(entries));
  const storage = {
    get length() { return data.size; },
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: vi.fn((key: string) => { data.delete(key); }),
    clear: () => data.clear(),
  };
  return { storage: storage as unknown as Storage, data, removeItem: storage.removeItem };
}

type Outcome = 'onsuccess' | 'onerror' | 'onblocked';
function fakeIdb(names: string[], outcome: Outcome = 'onsuccess') {
  const deleteDatabase = vi.fn((_name: string) => {
    const request: Record<string, unknown> = { onsuccess: null, onerror: null, onblocked: null, error: outcome === 'onerror' ? new Error('idb failed') : null };
    queueMicrotask(() => (request[outcome] as (() => void) | null)?.());
    return request;
  });
  return { idb: { databases: async () => names.map((name) => ({ name, version: 1 })), deleteDatabase } as unknown as IDBFactory, deleteDatabase };
}

function fakeOpfs(removeEntry = vi.fn(async (_name: string, _options?: { recursive?: boolean }) => {})) {
  return { opfsRoot: async () => ({ removeEntry }) as unknown as FileSystemDirectoryHandle, removeEntry };
}

const appKeys = () => ({
  'medusapos.session': '{}', 'medusapos.register_id': 'register-1', 'medusapos.settings.https://a.test': '{}',
  'other.key': 'kept', [CLEAR_FLAG_KEY]: '1',
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('clearAllLocalData', () => {
  it('deletes the OPFS pool, the legacy databases and every app key, the flag last', async () => {
    const { storage, data, removeItem } = fakeStorage(appKeys());
    const { idb, deleteDatabase } = fakeIdb(['rxdb-dexie-medusapos_medusa_x--0--pos_products', 'rxdb-dexie-medusapos_orders_x--0--pos_orders', 'unrelated']);
    const { opfsRoot, removeEntry } = fakeOpfs();
    await clearAllLocalData({ storage, opfsRoot, idb });
    expect(removeEntry).toHaveBeenCalledWith('.tallyui', { recursive: true });
    expect(deleteDatabase.mock.calls.map(([name]) => name).sort()).toEqual(
      ['rxdb-dexie-medusapos_medusa_x--0--pos_products', 'rxdb-dexie-medusapos_orders_x--0--pos_orders']);
    expect([...data.keys()]).toEqual(['other.key']);
    expect(removeItem.mock.calls.at(-1)).toEqual([CLEAR_FLAG_KEY]);
    expect(removeItem).toHaveBeenCalledTimes(4);
  });

  it('treats a missing pool as done', async () => {
    const { storage, data } = fakeStorage(appKeys());
    const { opfsRoot } = fakeOpfs(vi.fn(async () => { throw new DOMException('x', 'NotFoundError'); }));
    await clearAllLocalData({ storage, opfsRoot, idb: fakeIdb([]).idb });
    expect([...data.keys()]).toEqual(['other.key']);
  });

  it('keeps the flag when a step fails', async () => {
    const cases: [Partial<Parameters<typeof clearAllLocalData>[0]>, string][] = [
      [{ opfsRoot: fakeOpfs(vi.fn(async () => { throw new DOMException('x', 'NoModificationAllowedError'); })).opfsRoot }, 'x'],
      [{ idb: fakeIdb(['rxdb-dexie-medusapos_orders_x--0--pos_orders'], 'onblocked').idb }, 'A legacy database is still open in another tab.'],
      [{ idb: fakeIdb(['rxdb-dexie-medusapos_orders_x--0--pos_orders'], 'onerror').idb }, 'idb failed'],
    ];
    for (const [deps, message] of cases) {
      const { storage, data } = fakeStorage(appKeys());
      await expect(clearAllLocalData({ storage, opfsRoot: fakeOpfs().opfsRoot, idb: fakeIdb([]).idb, ...deps })).rejects.toThrow(message);
      expect(data.get(CLEAR_FLAG_KEY)).toBe('1');
      expect(data.has('medusapos.session')).toBe(true);
    }
  });

  it('runs only on the exact flag', () => {
    expect(isClearPending(null)).toBe(false);
    expect(isClearPending(fakeStorage().storage)).toBe(false);
    expect(isClearPending(fakeStorage({ [CLEAR_FLAG_KEY]: 'true' }).storage)).toBe(false);
    expect(isClearPending(fakeStorage({ [CLEAR_FLAG_KEY]: '0' }).storage)).toBe(false);
    expect(isClearPending(fakeStorage({ [CLEAR_FLAG_KEY]: '1' }).storage)).toBe(true);
    // reloadPage is location.reload(); requestClearLocalData calls it inside its own module, so the mock is location's.
    const reload = vi.fn();
    vi.stubGlobal('location', { reload });
    const { storage, data } = fakeStorage();
    requestClearLocalData(storage);
    expect(data.get(CLEAR_FLAG_KEY)).toBe('1');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('names everything unsent and an open till', () => {
    const nothing = 'Nothing is waiting to be sent, so your server already has your sales.';
    const salesNote = 'Unsent sales may be completed sales that exist only on this device.';
    const tillNote = 'Till entries are till opens, pay ins and outs, and closures.';
    const lost = 'never reached your server and will be permanently lost.';
    const risk = (sales: number, tillEntries: number, tillOpen: boolean, registerContract: number) =>
      clearWarnings({ sales, tillEntries, tillOpen, registerContract });
    expect(risk(0, 0, false, 3)).toEqual({ lines: [nothing], atRisk: false });
    expect(risk(1, 0, false, 3)).toEqual({ lines: [`1 sale on this device has ${lost}`, salesNote], atRisk: true });
    expect(risk(2, 3, false, 3)).toEqual({ lines: [`2 sales and 3 till entries on this device have ${lost}`, salesNote, tillNote], atRisk: true });
    expect(risk(0, 1, false, 3)).toEqual({ lines: [`1 till entry on this device has ${lost}`, tillNote], atRisk: true });
    expect(risk(0, 0, true, 3)).toEqual({ lines: [nothing,
      'The till is open. Its session stays open on your server: after the reset, open this register again and choose Take over.'], atRisk: true });
    expect(risk(0, 0, true, 1)).toEqual({ lines: [nothing,
      "The till is open. Its session stays open on your server, and this device can't take it over after the reset. Close the till first."], atRisk: true });
    expect(risk(0, 0, true, 0)).toEqual({ lines: [nothing,
      "The till is open. This store doesn't keep till records, so its cash record (float, pay ins and outs) will be lost."], atRisk: true });
    expect(risk(0, 0, false, 0)).toEqual({ lines: [nothing,
      "This store doesn't keep till records, so this device's till history will be lost."], atRisk: false });
  });
});
