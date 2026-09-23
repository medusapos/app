import { removeRxDatabase, type RxStorage } from 'rxdb';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import { getRxStorageDexie } from 'rxdb/plugins/storage-dexie';

const openCaches = new Map<string, { remove(): Promise<unknown> }>();

/** Persistent browser storage, with memory storage for environments without IndexedDB. */
export function productCacheStorage(): RxStorage<any, any> {
  return globalThis.indexedDB ? getRxStorageDexie() : getRxStorageMemory();
}

/** Names one backend using an injective encoding of its exact UTF-16 base URL. */
export function productCacheName(connectorId: string, baseUrl: string): string {
  const encoded = baseUrl.replace(/[^a-z0-9]/g, (c) => `_${c.charCodeAt(0).toString(16)}_`);
  return `medusapos_${connectorId}_${encoded}`;
}

/** Registers an open cache so sign-out can remove it. */
export function registerOpenCache(name: string, db: { remove(): Promise<unknown> }): () => void {
  openCaches.set(name, db);
  return () => { if (openCaches.get(name) === db) openCaches.delete(name); };
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
