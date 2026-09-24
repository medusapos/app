import { removeRxDatabase, type RxStorage } from 'rxdb';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import { getRxStorageDexie } from 'rxdb/plugins/storage-dexie';

type CachedDb = { remove(): Promise<unknown>; close(): Promise<unknown> };

const openCaches = new Map<string, CachedDb>();
// The once-close functions `registerOpenCache` returns, kept so `closeProductCaches`
// can call the very same once-close instead of starting a second `db.close()`.
const closers = new Map<string, () => Promise<void>>();
// Close promises already started (by the function `registerOpenCache` returns, or by
// `closeProductCaches` itself), kept until they settle so a close started by one is
// still awaited by the other even after its cache is gone from `openCaches`.
const pendingCloses = new Set<Promise<void>>();

/** Persistent browser storage, with memory storage for environments without IndexedDB. */
export function productCacheStorage(): RxStorage<any, any> {
  return globalThis.indexedDB ? getRxStorageDexie() : getRxStorageMemory();
}

/** Names one backend using an injective encoding of its exact UTF-16 base URL. */
export function productCacheName(connectorId: string, baseUrl: string): string {
  const encoded = baseUrl.replace(/[^a-z0-9]/g, (c) => `_${c.charCodeAt(0).toString(16)}_`);
  return `medusapos_${connectorId}_${encoded}`;
}

function startClose(name: string, db: CachedDb): Promise<void> {
  if (openCaches.get(name) === db) openCaches.delete(name);
  const closing = Promise.resolve(db.close()).then(() => undefined);
  pendingCloses.add(closing);
  void closing.finally(() => pendingCloses.delete(closing));
  return closing;
}

/**
 * Registers an open cache so sign-out can remove it, and returns a once-only
 * close: every call unregisters and closes the database, and every call
 * returns the same promise.
 */
export function registerOpenCache(name: string, db: CachedDb): () => Promise<void> {
  openCaches.set(name, db);
  let closing: Promise<void> | undefined;
  const close = () => (closing ??= startClose(name, db));
  closers.set(name, close);
  return close;
}

/**
 * Closes every registered cache through that same once-close, and also
 * awaits closes already started (by the function above) that have not
 * finished yet.
 */
export async function closeProductCaches(): Promise<void> {
  for (const close of closers.values()) close();
  await Promise.all(pendingCloses);
}

/** Removes an open or closed backend cache without throwing. */
export async function clearProductCache(connectorId: string, baseUrl: string): Promise<void> {
  const name = productCacheName(connectorId, baseUrl);
  const db = openCaches.get(name);
  try {
    if (db) await db.remove();
    else await removeRxDatabase(name, productCacheStorage());
  } catch { /* Cache cleanup must not prevent sign-out. */ }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Recognizes Medusa's HTTP 401 error, including RxDB's replication wrapper. */
export function isUnauthorizedError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  if (error.message === 'Medusa API error: 401') return true;
  const parameters = error.parameters;
  if (!isRecord(parameters) || !Array.isArray(parameters.errors)) return false;
  const first: unknown = parameters.errors[0];
  return isRecord(first) && first.message === 'Medusa API error: 401';
}
