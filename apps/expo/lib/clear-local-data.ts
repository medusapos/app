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

export type ClearRisk = {
  /** Sales not on the server: order outbox pending + rejected + saves in flight. */
  sales: number;
  /** Till entries not on the server: registerOutbox.state.pending. */
  tillEntries: number;
  /** register.session status is 'open' or 'counting'. */
  tillOpen: boolean;
  /** session.capabilities.register, or 0 when absent. */
  registerContract: number;
};
export const CLEAR_CONFIRM_WORD = 'CLEAR';

const counted = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// The open server session is safe: after the wipe this device has a new id, so its open is refused and Take over
// supersedes the old session, recording superseded_by_device. Contract 1 has no take-over, so the dialog says close first.
export function clearWarnings(risk: ClearRisk): { lines: string[]; atRisk: boolean } {
  const { sales, tillEntries, tillOpen, registerContract } = risk;
  const parts = [sales ? counted(sales, 'sale', 'sales') : '', tillEntries ? counted(tillEntries, 'till entry', 'till entries') : '']
    .filter(Boolean);
  const lines = [parts.length === 0
    ? 'Nothing is waiting to be sent, so your server already has your sales.'
    : `${parts.join(' and ')} on this device ${sales + tillEntries === 1 ? 'has' : 'have'} never reached your server and will be permanently lost.`];
  if (sales > 0) lines.push('Unsent sales may be completed sales that exist only on this device.');
  if (tillEntries > 0) lines.push('Till entries are till opens, pay ins and outs, and closures.');
  if (tillOpen) {
    lines.push(registerContract >= 2
      ? 'The till is open. Its session stays open on your server: after the reset, open this register again and choose Take over.'
      : registerContract === 1
        ? "The till is open. Its session stays open on your server, and this device can't take it over after the reset. Close the till first."
        : "The till is open. This store doesn't keep till records, so its cash record (float, pay ins and outs) will be lost.");
  } else if (registerContract === 0) {
    lines.push("This store doesn't keep till records, so this device's till history will be lost.");
  }
  return { lines, atRisk: sales + tillEntries > 0 || tillOpen };
}
