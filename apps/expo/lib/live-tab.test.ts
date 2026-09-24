import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
