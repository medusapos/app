import type { RxStorageSQLiteWasm } from '@tallyui/storage-sqlite/web';
import { Platform } from 'react-native';
import { getRxStorageSQLiteWasm } from '@tallyui/storage-sqlite/web';

// Built by this app's `build:sqlite-worker` script (package.json: `tallyui-build-sqlite-worker
// public/sqlite`, run before `build:web`/`web`/`dev`) into `public/sqlite/`.
export const SQLITE_WORKER_URL = '/sqlite/tallyui-sqlite-worker.js';

/** True where the web SQLite-wasm storage can run: web, with a dedicated Worker and OPFS. */
export function webStorageAvailable(): boolean {
  return Platform.OS === 'web' && typeof globalThis.Worker !== 'undefined'
    && typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory;
}

/** Web without SQLite-wasm support: sales would only live in memory, so nothing opens. */
export class UnsupportedStorageError extends Error {
  constructor() {
    super('This browser can\'t store sales safely (no OPFS worker storage). Use a current Chrome, Edge, Safari or Firefox over HTTPS.');
    this.name = 'UnsupportedStorageError';
  }
}

// TEST-ONLY: jsdom has no OPFS. Set by apps/expo/tests/setup-storage.ts (a vitest setupFiles
// entry) so `productCacheStorage()` returns memory storage there; production never sets it.
let memoryStorageForTests = false;

/** TEST-ONLY (see above): makes `productCacheStorage()` return memory storage on web. */
export function useMemoryStorageForTests(): void {
  memoryStorageForTests = true;
}

/** TEST-ONLY (see above): true once `useMemoryStorageForTests()` ran. */
export function usingMemoryStorageForTests(): boolean {
  return memoryStorageForTests;
}

let cachedStorage: RxStorageSQLiteWasm | undefined;
// Set synchronously by workerInput below (mode 'one' calls it eagerly) — kept so the e2e crash
// hook (`__medusaposKillStorageWorker` below) can end it without forgetting the storage.
let keptWorker: Worker | undefined;

/**
 * Lazily builds and caches the one storage object (and its one dedicated
 * worker) both local databases share on web (ADR-061): a second storage
 * object would start a second worker, whose opfs-sahpool install fails.
 */
export function getWebStorage(): RxStorageSQLiteWasm {
  if (!cachedStorage) {
    cachedStorage = getRxStorageSQLiteWasm({
      workerInput: () => {
        keptWorker = new Worker(SQLITE_WORKER_URL, { type: 'module', name: 'medusapos-storage' });
        return keptWorker;
      },
    });
  }
  return cachedStorage;
}

/**
 * Terminates the kept storage, if any, and forgets it, so the next
 * `getWebStorage()` builds a fresh storage and worker. Synchronous, so it
 * still runs from a page already being torn down (see `closeDatabases`).
 *
 * TallyUI's `terminate()` handles it: it ends the worker and evicts RxDB
 * Premium's mode-'one' message channel cache, which otherwise keeps that
 * channel alive for the page's whole life and would hand the next storage a
 * channel to this now-dead worker.
 */
export function terminateWebStorage(): void {
  cachedStorage?.terminate();
  keptWorker = undefined;
  cachedStorage = undefined;
}

// E2E debug hook (like `__medusaposCatalogue`): kills the kept worker WITHOUT forgetting the
// storage, simulating a crash (unlike `terminateWebStorage`'s graceful close-then-terminate).
// Any call in flight, or made after, never gets a reply — surfacing on `health$` as `dead`.
if (process.env.EXPO_PUBLIC_E2E_DEBUG === '1' && typeof window !== 'undefined') {
  (window as Window & { __medusaposKillStorageWorker?: () => void }).__medusaposKillStorageWorker = () => {
    keptWorker?.terminate();
  };
}
