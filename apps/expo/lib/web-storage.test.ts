import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Platform } from 'react-native';

// apps/expo/tests/setup-storage.ts (a setupFiles entry) already imported the real './web-storage'
// and, through it, the real '@tallyui/storage-sqlite/web'; a fresh module registry lets the mock
// below apply to this file's own import.
vi.hoisted(() => vi.resetModules());

// The real `@tallyui/storage-sqlite/web` calls into rxdb-premium's own
// `web-worker` dependency, which resolves to a worker_threads shim under
// Node/vitest and rejects any stubbed `Worker` with "no Worker given" — a
// Node-only artifact, not something a real browser hits. This fake mirrors
// the one behavior this glue relies on: mode 'one' calls `workerInput`
// synchronously while building the storage object.
vi.mock('@tallyui/storage-sqlite/web', () => ({
  getRxStorageSQLiteWasm: vi.fn((options: { workerInput: () => Worker }) => {
    const worker = options.workerInput();
    return { name: 'sqlite-wasm-stub', worker, terminate: vi.fn(() => worker.terminate()) };
  }),
}));

import { getRxStorageSQLiteWasm } from '@tallyui/storage-sqlite/web';
import { getWebStorage, SQLITE_WORKER_URL, terminateWebStorage, webStorageAvailable } from './web-storage';

class FakeWorker {
  terminate = vi.fn();
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
  postMessage = vi.fn();
  constructor(public url: string, public options: unknown) {}
}

beforeEach(() => {
  vi.mocked(getRxStorageSQLiteWasm).mockClear();
});

afterEach(() => {
  terminateWebStorage();
  vi.unstubAllGlobals();
});

describe('webStorageAvailable', () => {
  it('is false without a Worker global', () => {
    const original = Platform.OS;
    Platform.OS = 'web';
    vi.stubGlobal('Worker', undefined);
    vi.stubGlobal('navigator', { storage: { getDirectory: () => {} } });
    try {
      expect(webStorageAvailable()).toBe(false);
    } finally { Platform.OS = original; }
  });

  it('is true on web with a Worker and OPFS', () => {
    const original = Platform.OS;
    Platform.OS = 'web';
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('navigator', { storage: { getDirectory: () => {} } });
    try {
      expect(webStorageAvailable()).toBe(true);
    } finally { Platform.OS = original; }
  });

  it('is false off web even with a Worker and OPFS', () => {
    const original = Platform.OS;
    Platform.OS = 'ios';
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('navigator', { storage: { getDirectory: () => {} } });
    try {
      expect(webStorageAvailable()).toBe(false);
    } finally { Platform.OS = original; }
  });
});

describe('getWebStorage / terminateWebStorage', () => {
  beforeEach(() => {
    vi.stubGlobal('Worker', FakeWorker);
  });

  it('returns the same object twice and constructs one Worker', () => {
    const first = getWebStorage();
    const second = getWebStorage();
    expect(second).toBe(first);
    expect(getRxStorageSQLiteWasm).toHaveBeenCalledOnce();
    const worker = (first as unknown as { worker: FakeWorker }).worker;
    expect(worker).toBeInstanceOf(FakeWorker);
    expect(worker.url).toBe(SQLITE_WORKER_URL);
    expect(worker.options).toEqual({ type: 'module', name: 'medusapos-storage' });
  });

  it('terminates the kept worker and builds a fresh one on the next call', () => {
    const first = getWebStorage() as unknown as { worker: FakeWorker; terminate: () => void };
    const firstWorker = first.worker;

    terminateWebStorage();
    expect(first.terminate).toHaveBeenCalledOnce();
    expect(firstWorker.terminate).toHaveBeenCalledOnce();

    const second = getWebStorage();
    expect(second).not.toBe(first);
    expect(getRxStorageSQLiteWasm).toHaveBeenCalledTimes(2);
    const secondWorker = (second as unknown as { worker: FakeWorker }).worker;
    expect(secondWorker).not.toBe(firstWorker);
  });

  it('does nothing when terminated before ever built', () => {
    expect(() => terminateWebStorage()).not.toThrow();
    expect(getRxStorageSQLiteWasm).not.toHaveBeenCalled();
  });
});
