import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isStorageWorkerFailure } from '@tallyui/database';
import { StorageUnavailableError, StorageWorkerStartError } from '@tallyui/storage-sqlite/web';

const { closeOrderStoresMock, closeProductCachesMock, terminateWebStorageMock } = vi.hoisted(() => ({
  closeOrderStoresMock: vi.fn(),
  closeProductCachesMock: vi.fn(),
  terminateWebStorageMock: vi.fn(),
}));

vi.mock('./order-store', () => ({ closeOrderStores: closeOrderStoresMock }));
vi.mock('./product-cache', () => ({ closeProductCaches: closeProductCachesMock }));
vi.mock('./web-storage', () => ({ terminateWebStorage: terminateWebStorageMock }));

// Imported after the mocks above, and freshly for each test (module state,
// including `storageNeedsReload`'s flag, must not leak between tests).
async function importLiveTab() {
  vi.resetModules();
  return import('./live-tab');
}

beforeEach(() => {
  vi.useFakeTimers();
  closeOrderStoresMock.mockReset();
  closeProductCachesMock.mockReset();
  terminateWebStorageMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('storageStartFailureOf', () => {
  it('recognises storage unavailable even though isStorageWorkerFailure does not', async () => {
    const { storageStartFailureOf } = await importLiveTab();
    const error = new StorageUnavailableError('StorageUnavailableError: no OPFS');
    expect(isStorageWorkerFailure(error)).toBe(false);
    expect(storageStartFailureOf(error)).toBe('unavailable');
  });

  it.each([
    [new Error('could not create instance ' + JSON.stringify({
      name: 'StorageUnavailableError', message: 'StorageUnavailableError: no OPFS',
    })), 'unavailable'],
    [new StorageWorkerStartError('StorageWorkerStartError: another tab holds the database (opfs-sahpool): locked'), 'held'],
    [Object.assign(new Error('RM1'), { code: 'RM1', rxdb: true }), 'stale'],
    [new StorageWorkerStartError('StorageWorkerStartError: SQLite worker start failed: boom'), 'failed'],
    [new Error('DM4'), null],
  ])('classifies %s as %s', async (error, expected) => {
    const { storageStartFailureOf } = await importLiveTab();
    expect(storageStartFailureOf(error)).toBe(expected);
  });
});

it('keeps the first reported failure', async () => {
  const { reportStorageStartFailure, storageStartFailed$ } = await importLiveTab();
  const emitted = vi.fn();
  const subscription = storageStartFailed$.subscribe(emitted);
  reportStorageStartFailure('held');
  reportStorageStartFailure('stale');
  expect(emitted.mock.calls).toEqual([[null], ['held']]);
  subscription.unsubscribe();
});

describe('closeDatabases park order', () => {
  it('calls terminateWebStorage only after both closes resolved, and storageNeedsReload stays false', async () => {
    let resolveOrders!: () => void;
    let resolveProducts!: () => void;
    closeOrderStoresMock.mockReturnValue(new Promise<void>((resolve) => { resolveOrders = resolve; }));
    closeProductCachesMock.mockReturnValue(new Promise<void>((resolve) => { resolveProducts = resolve; }));
    const { closeDatabases, storageNeedsReload } = await importLiveTab();

    const closing = closeDatabases();
    expect(terminateWebStorageMock).not.toHaveBeenCalled();

    resolveOrders();
    await Promise.resolve();
    expect(terminateWebStorageMock).not.toHaveBeenCalled();

    resolveProducts();
    await closing;

    expect(terminateWebStorageMock).toHaveBeenCalledOnce();
    expect(storageNeedsReload()).toBe(false);
  });

  it('resolves after PARK_CLOSE_LIMIT_MS when a close never settles, terminating the worker and needing a reload', async () => {
    closeOrderStoresMock.mockReturnValue(new Promise<void>(() => {}));
    closeProductCachesMock.mockReturnValue(new Promise<void>(() => {}));
    const { closeDatabases, PARK_CLOSE_LIMIT_MS, storageNeedsReload } = await importLiveTab();

    const closing = closeDatabases();
    let settled = false;
    void closing.then(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(PARK_CLOSE_LIMIT_MS - 1);
    expect(settled).toBe(false);
    expect(terminateWebStorageMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await closing;

    expect(settled).toBe(true);
    expect(terminateWebStorageMock).toHaveBeenCalledOnce();
    expect(storageNeedsReload()).toBe(true);
  });

  it('never rejects, even when a close rejects', async () => {
    closeOrderStoresMock.mockRejectedValue(new Error('close failed'));
    closeProductCachesMock.mockResolvedValue(undefined);
    const { closeDatabases } = await importLiveTab();

    await expect(closeDatabases()).resolves.toBeUndefined();
    expect(terminateWebStorageMock).toHaveBeenCalledOnce();
  });
});
