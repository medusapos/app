import { removeRxDatabase, type RxStorage } from 'rxdb';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import { Platform } from 'react-native';
import { defaultStorage } from './session';
import { getWebStorage, UnsupportedStorageError, usingMemoryStorageForTests, webStorageAvailable } from './web-storage';

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

/**
 * Persistent storage on web (ADR-061's SQLite-wasm); memory on native. Web without SQLite-wasm
 * support throws `UnsupportedStorageError` rather than keep sales only in memory (unless a test
 * run called `useMemoryStorageForTests()`).
 */
export function productCacheStorage(): RxStorage<any, any> {
  if (webStorageAvailable()) return getWebStorage();
  if (Platform.OS !== 'web' || usingMemoryStorageForTests()) return getRxStorageMemory();
  throw new UnsupportedStorageError();
}

function encodeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/[^a-z0-9]/g, (c) => `_${c.charCodeAt(0).toString(16)}_`);
}

/** Names one backend using an injective encoding of its exact UTF-16 base URL. */
export function productCacheName(connectorId: string, baseUrl: string): string {
  return `medusapos_sqlite_${connectorId}_${encodeBaseUrl(baseUrl)}`;
}

// 32-bit FNV-1a as 8 hex digits: stable and synchronous.
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * The product cache for one backend and pricing context: a context change, or the upgrade from
 * unpriced documents (no context), is a cold resync under a new name (TallyUI's drop-and-resync rule).
 */
export function pricedCacheName(connectorId: string, baseUrl: string, pricingContext?: Record<string, string>): string {
  const key = pricingContext ? `${pricingContext.region_id ?? ''}\n${pricingContext.publishable_key ?? ''}` : 'none';
  return `${productCacheName(connectorId, baseUrl)}_${fnv1a(key)}`;
}

// The current product cache name per store, so a sweep and sign-out find it.
const recordKey = (baseUrl: string) => `medusapos.product-cache.${baseUrl}`;

/**
 * After the first successful sync under `name`: removes the store's previously recorded cache (or,
 * with none recorded, the unsuffixed cache from before priced replication) if it differs and is
 * not open, then records `name`. Never throws.
 */
export async function sweepProductCaches(connectorId: string, baseUrl: string, name: string): Promise<void> {
  const storage = defaultStorage();
  try {
    const previous = storage?.getItem(recordKey(baseUrl)) ?? productCacheName(connectorId, baseUrl);
    if (previous !== name && !openCaches.has(previous)) {
      await closers.get(previous)?.(); // closed already, but the close may still be settling
      await removeRxDatabase(previous, productCacheStorage());
    }
  } catch { /* Cache cleanup must never throw. */ }
  try { storage?.setItem(recordKey(baseUrl), name); } catch { /* Web storage may be unavailable. */ }
}

/**
 * The pre-SQLite Dexie name for the same backend (same injective encoding,
 * the old prefix): the source for the one-time order carry-over, and what
 * `deleteLegacyProductCache` clears.
 */
export function legacyDexieName(connectorId: string, baseUrl: string): string {
  return `medusapos_${connectorId}_${encodeBaseUrl(baseUrl)}`;
}

/**
 * Deletes every IndexedDB database RxDB's Dexie storage created for the
 * pre-SQLite product cache of one backend. Never throws.
 */
export async function deleteLegacyProductCache(connectorId: string, baseUrl: string): Promise<void> {
  try {
    const databases = await globalThis.indexedDB?.databases?.();
    if (!databases) return;
    const prefix = `rxdb-dexie-${legacyDexieName(connectorId, baseUrl)}--`;
    const names = databases.map((d) => d.name).filter((name): name is string => !!name?.startsWith(prefix));
    await Promise.all(names.map((name) => new Promise<void>((resolve) => {
      const request = globalThis.indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    })));
  } catch { /* Legacy cache cleanup must never throw. */ }
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

/**
 * Removes the store's recorded (current) product cache, open or closed, and its record, without
 * throwing. With none recorded, it removes the unsuffixed cache from before priced replication.
 */
export async function clearProductCache(connectorId: string, baseUrl: string): Promise<void> {
  const storage = defaultStorage();
  try {
    const name = storage?.getItem(recordKey(baseUrl)) ?? productCacheName(connectorId, baseUrl);
    storage?.removeItem(recordKey(baseUrl));
    const db = openCaches.get(name);
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
