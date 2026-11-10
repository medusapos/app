// Settings › Danger zone › Clear all local data (WCPOS v2's, web only): Settings sets the flag and reloads; the
// gate (components/clear-local-data.tsx) wipes at startup, before the session is read or any database opens.
export const CLEAR_FLAG_KEY = 'medusapos.clear-on-next-load';
export const STORAGE_PREFIX = 'medusapos.';
// The opfs-sahpool VFS's directory: @tallyui/storage-sqlite's web worker.ts installs it as `{ name: 'tallyui' }`,
// whose default directory is `.tallyui` at the OPFS root. Every local database file lives in it.
export const OPFS_POOL_DIR = '.tallyui';
// The pre-SQLite Dexie databases (lib/product-cache.ts, lib/order-store.ts).
export const LEGACY_IDB_PREFIX = 'rxdb-dexie-medusapos_';

// WCPOS v2's copy (monorepo main, packages/core/src/contexts/translations/locales/en/core.json).
export const CLEAR_BODY = 'Everything stored on this device is deleted and downloaded again from your server.';

type ClearDeps = { storage: Storage; opfsRoot: () => Promise<FileSystemDirectoryHandle>; idb: IDBFactory };

export function reloadPage(): void {
  globalThis.location.reload();
}

/** True only when the flag holds exactly '1'. */
export function isClearPending(storage: Pick<Storage, 'getItem'> | null): boolean {
  return storage?.getItem(CLEAR_FLAG_KEY) === '1';
}

export function requestClearLocalData(storage: Storage): void {
  storage.setItem(CLEAR_FLAG_KEY, '1');
  reloadPage();
}

function deleteDatabase(idb: IDBFactory, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = idb.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error(`Could not delete ${name}.`));
    request.onblocked = () => reject(new Error('A legacy database is still open in another tab.'));
  });
}

/** Deletes the OPFS pool, the legacy databases and every app key; the flag goes last, so a failure retries. */
export async function clearAllLocalData(deps: ClearDeps): Promise<void> {
  try {
    await (await deps.opfsRoot()).removeEntry(OPFS_POOL_DIR, { recursive: true });
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
  }
  for (const { name } of await deps.idb.databases()) {
    if (name?.startsWith(LEGACY_IDB_PREFIX)) await deleteDatabase(deps.idb, name);
  }
  const keys: string[] = [];
  for (let i = 0; i < deps.storage.length; i++) {
    const key = deps.storage.key(i);
    if (key?.startsWith(STORAGE_PREFIX)) keys.push(key);
  }
  for (const key of keys) if (key !== CLEAR_FLAG_KEY) deps.storage.removeItem(key);
  deps.storage.removeItem(CLEAR_FLAG_KEY);
}

export function defaultClearDeps(): ClearDeps {
  return { storage: globalThis.localStorage, opfsRoot: () => navigator.storage.getDirectory(), idb: globalThis.indexedDB };
}

// WCPOS v2's copy (as CLEAR_BODY).
export function unsentWarning(count: number): string {
  if (count === 0) return 'Nothing is waiting to be sent, so your server already has your sales.';
  if (count === 1) return '1 change on this device has never reached your server and will be permanently lost. It may be a completed sale that exists only on this device.';
  return `${count} changes on this device have never reached your server and will be permanently lost. They may include completed sales that exist only on this device.`;
}
