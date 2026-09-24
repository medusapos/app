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
// Opens from `openProductCache` still in flight: resolves to the registered
// `{ close }`, or `undefined` if the open failed (which counts as closed).
const pendingOpens = new Set<Promise<{ close: () => Promise<void> } | undefined>>();

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
 * Opens a cache, tracked while in flight so `closeProductCaches` can wait
 * for it, and registers the result through the same once-close as `registerOpenCache`.
 */
export function openProductCache<T extends CachedDb>(
  name: string, open: () => Promise<T>,
): Promise<{ db: T; close: () => Promise<void> }> {
  const opened = open().then((db) => ({ db, close: registerOpenCache(name, db) }));
  const tracked = opened.catch(() => undefined);
  pendingOpens.add(tracked);
  void tracked.finally(() => pendingOpens.delete(tracked));
  return opened;
}

/**
 * Closes every registered cache through that same once-close, awaits closes
 * already started that have not finished, and waits for every open still in
 * flight before closing what it opened the same way.
 */
export async function closeProductCaches(): Promise<void> {
  for (const close of closers.values()) close();
  const opens = Array.from(pendingOpens);
  await Promise.all(pendingCloses);
  const opened = (await Promise.all(opens)).filter((o) => o !== undefined);
  await Promise.all(opened.map((o) => o.close()));
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
