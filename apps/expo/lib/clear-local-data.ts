// Settings › Danger zone › Clear all local data (WCPOS v2's, web only): Settings sets the flag and reloads; the
// gate (components/clear-local-data.tsx) wipes at startup, before the session is read or any database opens.
export const CLEAR_FLAG_KEY = 'medusapos.clear-on-next-load';
export const STORAGE_PREFIX = 'medusapos.';
// The opfs-sahpool VFS's directory: @tallyui/storage-sqlite's web worker.ts installs it as `{ name: 'tallyui' }`,
// whose default directory is `.tallyui` at the OPFS root. Every local database file lives in it.
export const OPFS_POOL_DIR = '.tallyui';
// The pre-SQLite Dexie databases (lib/product-cache.ts, lib/order-store.ts).
export const LEGACY_IDB_PREFIX = 'rxdb-dexie-medusapos_';

export const CLEAR_BODY = "Your products, customers and orders are downloaded again from your server. This device's own settings are "
  + 'reset: the till name, scanner settings and other device choices, and you sign in again.';

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

/**
 * Deletes the legacy databases, then the OPFS pool, then every app key; the flag goes last, so a failure retries.
 * Legacy first: the carry-over marker lives in the pool, so a failure (then Cancel reset) before the pool goes keeps it.
 */
export async function clearAllLocalData(deps: ClearDeps): Promise<void> {
  // Never skip the legacy sweep: the wipe drops the carry-over marker, so kept Dexie orders would come back as unsent.
  if (typeof deps.idb.databases !== 'function') throw new Error("This browser can't list its databases, so nothing was deleted.");
  for (const { name } of await deps.idb.databases()) {
    if (name?.startsWith(LEGACY_IDB_PREFIX)) await deleteDatabase(deps.idb, name);
  }
  try {
    await (await deps.opfsRoot()).removeEntry(OPFS_POOL_DIR, { recursive: true });
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
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

// Each count is null until it is read: unknown is at risk, never zero.
export type ClearRisk = {
  /** Sales not on the server: order outbox pending + rejected + saves in flight. */
  sales: number | null;
  /** Parked sales: every `drafts` document, as TallyUI's useParkedSales lists them. */
  parked: number | null;
  /** register_commands not applied: pending, or refused by the server. */
  tillEntries: number | null;
  /** The local `closures` documents; 0 unless registerContract is 0. */
  localClosures: number | null;
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
  const { tillOpen, registerContract } = risk;
  const unknown = [risk.sales, risk.parked, risk.tillEntries, risk.localClosures].some((n) => n === null);
  const [sales, parked, tillEntries, closures] = [risk.sales ?? 0, risk.parked ?? 0, risk.tillEntries ?? 0, risk.localClosures ?? 0];
  const parts = [sales ? counted(sales, 'sale', 'sales') : '', parked ? counted(parked, 'parked sale', 'parked sales') : '',
    tillEntries ? counted(tillEntries, 'till entry', 'till entries') : ''].filter(Boolean);
  const listed = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0];
  const lines = [unknown
    ? "Can't tell yet what is unsent on this device, so treat it as lost."
    : !listed
      ? 'Nothing is waiting to be sent, so your server already has your sales.'
      : `${listed} on this device ${sales + parked + tillEntries === 1 ? 'has' : 'have'} never reached your server and will be permanently lost.`];
  if (sales > 0) lines.push('Unsent sales may be completed sales that exist only on this device.');
  if (parked > 0) lines.push('Parked sales are kept only on this device.');
  if (tillEntries > 0) lines.push('Till entries are till opens, pay ins and outs, and closures, including any your server refused.');
  if (tillOpen) {
    lines.push(registerContract >= 2
      ? 'The till is open. Its session stays open on your server: after the reset, open this register again and choose Take over.'
      : registerContract === 1
        ? "The till is open, and this store's MedusaPOS plugin can't hand an open session to another device. Close the register "
          + 'first: open the register panel and choose Close register. If you reset now, the session stays open on your server '
          + 'and no till can close it until whoever runs your Medusa server updates the MedusaPOS plugin; then open this '
          + 'register again and choose Take over.'
        : "The till is open. This store doesn't keep till records, so its cash record (float, pay ins and outs) will be lost.");
  } else if (registerContract === 0 && closures > 0) {
    lines.push(`This store doesn't keep till records, so this device's till history (${counted(closures, 'till closure', 'till closures')}) will be lost.`);
  }
  return { lines, atRisk: unknown || sales + parked + tillEntries + closures > 0 || tillOpen };
}
