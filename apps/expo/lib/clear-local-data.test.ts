import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRxDatabase, type RxCollection, type RxDatabase } from 'rxdb';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import { wrappedValidateAjvStorage } from 'rxdb/plugins/validate-ajv';
import { addPosOrderCollection, createOrderBuilder, finalizeOrder, type PosOrder } from '@tallyui/pos';
import {
  CLEAR_FLAG_KEY, clearAllLocalData, clearWarnings, isClearPending, requestClearLocalData,
} from './clear-local-data';
import { carryOverOrders, orderDatabaseName } from './order-store';

// As order-store.test.ts's helpers: a memory order database, and one finalized sale.
const memoryStorage = () => wrappedValidateAjvStorage({ storage: getRxStorageMemory() });
async function memoryOrdersDb(name: string, localDocuments = false) {
  const db = await createRxDatabase<{ pos_orders: RxCollection<PosOrder> }>({
    name, storage: memoryStorage(), multiInstance: false, localDocuments,
  });
  await addPosOrderCollection(db as unknown as RxDatabase);
  return db;
}
function sale(): PosOrder {
  const builder = createOrderBuilder({ currency: 'EUR', taxContext: { pricesIncludeTax: false, getTaxRatePpm: () => 0 } });
  builder.addLine({ productId: 'shirt', variantId: 'blue', name: 'Blue shirt', unitPrice: { amount: 1200, currency: 'EUR' } });
  builder.addPayment({ method: 'cash', amountMinor: 1200 });
  return finalizeOrder(builder.getSnapshot());
}

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

  it('a failed old-database delete, then Cancel reset: no order comes back as unsent', async () => {
    const name = orderDatabaseName('https://clear-cancel.test');
    const fromName = 'medusapos_orders_clear_cancel';
    const legacyExists = async () => true;
    const order = sale();
    // The legacy store still holds the order as it was before it synced.
    const legacy = await memoryOrdersDb(fromName);
    await legacy.pos_orders.insert({ ...order, syncStatus: 'pending' });
    await legacy.close();
    // The new store: the order has synced since it was copied, and the carry-over marker is written.
    const before = await memoryOrdersDb(name, true);
    await before.pos_orders.insert({ ...order, syncStatus: 'applied' });
    await carryOverOrders({ fromStorage: memoryStorage(), fromName, to: before, legacyExists });
    expect(await before.getLocal('legacy-orders-migrated')).not.toBeNull();

    const { storage, data } = fakeStorage(appKeys());
    // Removing the OPFS pool removes the new database; the legacy delete is blocked by another tab.
    const { opfsRoot } = fakeOpfs(vi.fn(async () => { await before.remove(); }));
    const { idb } = fakeIdb([`rxdb-dexie-${fromName}--0--pos_orders`], 'onblocked');
    await expect(clearAllLocalData({ storage, opfsRoot, idb })).rejects.toThrow('A legacy database is still open in another tab.');
    if (!before.closed) await before.close(); // The reload closes whatever is still open.

    // Cancel reset drops the flag; the app's next open reopens the store and runs the carry-over.
    data.delete(CLEAR_FLAG_KEY);
    const after = await memoryOrdersDb(name, true);
    try {
      await carryOverOrders({ fromStorage: memoryStorage(), fromName, to: after, legacyExists });
      const statuses = (await after.pos_orders.find().exec()).map((doc) => doc.syncStatus);
      expect(statuses.filter((status) => status === 'pending' || status === 'rejected')).toEqual([]);
      expect(statuses).toEqual(['applied']);
    } finally {
      await after.remove();
      await (await memoryOrdersDb(fromName)).remove();
    }
  });

  it('refuses before deleting anything when the browser cannot list its databases', async () => {
    const { storage, data, removeItem } = fakeStorage(appKeys());
    const { opfsRoot, removeEntry } = fakeOpfs();
    const { deleteDatabase } = fakeIdb([]);
    await expect(clearAllLocalData({ storage, opfsRoot, idb: { deleteDatabase } as unknown as IDBFactory }))
      .rejects.toThrow("This browser can't list its databases");
    expect(removeEntry).not.toHaveBeenCalled();
    expect(deleteDatabase).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
    expect(data.get(CLEAR_FLAG_KEY)).toBe('1');
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
    const tillNote = 'Till entries are till opens, pay ins and outs, and closures, including any your server refused.';
    const lost = 'never reached your server and will be permanently lost.';
    const risk = (sales: number, tillEntries: number, tillOpen: boolean, registerContract: number) =>
      clearWarnings({ sales, parked: 0, tillEntries, localClosures: 0, tillOpen, registerContract });
    expect(risk(0, 0, false, 3)).toEqual({ lines: [nothing], atRisk: false });
    expect(risk(1, 0, false, 3)).toEqual({ lines: [`1 sale on this device has ${lost}`, salesNote], atRisk: true });
    expect(risk(2, 3, false, 3)).toEqual({ lines: [`2 sales and 3 till entries on this device have ${lost}`, salesNote, tillNote], atRisk: true });
    expect(risk(0, 1, false, 3)).toEqual({ lines: [`1 till entry on this device has ${lost}`, tillNote], atRisk: true });
    expect(risk(0, 0, true, 3)).toEqual({ lines: [nothing,
      'The till is open. Its session stays open on your server: after the reset, open this register again and choose Take over.'], atRisk: true });
    expect(risk(0, 0, true, 1)).toEqual({ lines: [nothing,
      "The till is open, and this store's MedusaPOS plugin can't hand an open session to another device. Close the register first: "
      + 'open the register panel and choose Close register. If you reset now, the session stays open on your server and no till '
      + 'can close it until whoever runs your Medusa server updates the MedusaPOS plugin; then open this register again and choose '
      + 'Take over.'], atRisk: true });
    expect(risk(0, 0, true, 0)).toEqual({ lines: [nothing,
      "The till is open. This store doesn't keep till records, so its cash record (float, pay ins and outs) will be lost."], atRisk: true });
    expect(risk(0, 0, false, 0)).toEqual({ lines: [nothing], atRisk: false });
  });

  const base = { sales: 0, parked: 0, tillEntries: 0, localClosures: 0, tillOpen: false, registerContract: 3 };
  it('counts parked sales', () => {
    expect(clearWarnings({ ...base, parked: 1 })).toEqual({ lines: [
      '1 parked sale on this device has never reached your server and will be permanently lost.',
      'Parked sales are kept only on this device.'], atRisk: true });
    expect(clearWarnings({ ...base, sales: 2, parked: 1, tillEntries: 3 }).lines[0])
      .toBe('2 sales, 1 parked sale and 3 till entries on this device have never reached your server and will be permanently lost.');
  });

  it('treats a count not read yet as lost', () => {
    for (const key of ['sales', 'parked', 'tillEntries', 'localClosures'] as const) {
      const { lines, atRisk } = clearWarnings({ ...base, [key]: null });
      expect(lines).toEqual(["Can't tell yet what is unsent on this device, so treat it as lost."]);
      expect(atRisk).toBe(true);
    }
  });

  it('counts the till history of a store without till records', () => {
    const closed = { ...base, registerContract: 0 };
    expect(clearWarnings({ ...closed, localClosures: 2 })).toEqual({ lines: [
      'Nothing is waiting to be sent, so your server already has your sales.',
      "This store doesn't keep till records, so this device's till history (2 till closures) will be lost."], atRisk: true });
    expect(clearWarnings({ ...closed, localClosures: 1 }).lines[1]).toContain('(1 till closure)');
    expect(clearWarnings({ ...closed, localClosures: 0 })).toEqual({
      lines: ['Nothing is waiting to be sent, so your server already has your sales.'], atRisk: false });
  });
});
