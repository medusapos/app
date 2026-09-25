import type { RxStorage } from 'rxdb';
import { MESSAGE_CHANNEL_CACHE_BY_IDENTIFIER } from 'rxdb/plugins/storage-remote';
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

let cachedStorage: RxStorage<any, any> | undefined;
// Set synchronously by workerInput below (mode 'one' calls it eagerly) — kept so
// `terminateWebStorage` can end it.
let keptWorker: Worker | undefined;
// The same function passed as `workerInput` below, kept so `terminateWebStorage` can key RxDB
// Premium's own channel cache the same way it does (see there for why).
let keptWorkerInput: (() => Worker) | undefined;

/**
 * Lazily builds and caches the one storage object (and its one dedicated
 * worker) both local databases share on web (ADR-061): a second storage
 * object would start a second worker, whose opfs-sahpool install fails.
 */
export function getWebStorage(): RxStorage<any, any> {
  if (!cachedStorage) {
    keptWorkerInput = () => {
      keptWorker = new Worker(SQLITE_WORKER_URL, { type: 'module', name: 'medusapos-storage' });
      return keptWorker;
    };
    cachedStorage = getRxStorageSQLiteWasm({ workerInput: keptWorkerInput });
  }
  return cachedStorage;
}

/**
 * Terminates the kept worker, if any, and forgets the storage object, so the
 * next `getWebStorage()` builds a fresh storage and worker. Synchronous, so
 * it still runs from a page already being torn down (see `closeDatabases`).
 *
 * RxDB Premium's mode `'one'` caches its one shared message channel forever
 * by design (a page-lifetime singleton; no public API closes it), keyed by
 * `workerInput`'s function source — identical text on every call here, so
 * without evicting that entry, the next `getWebStorage()` would silently
 * hand back a channel to this now-dead worker and hang forever.
 */
export function terminateWebStorage(): void {
  keptWorker?.terminate();
  if (keptWorkerInput) MESSAGE_CHANNEL_CACHE_BY_IDENTIFIER.delete(`rx-storage-worker-${keptWorkerInput}`);
  keptWorker = undefined;
  keptWorkerInput = undefined;
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
