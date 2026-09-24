import { BehaviorSubject, type Observable } from 'rxjs';
import { closeOrderStores } from './order-store';
import { closeProductCaches } from './product-cache';
import { terminateWebStorage } from './web-storage';

export type BusyReason = 'payment' | 'outbox';

const busyReasons = new Set<BusyReason>();

/** Marks (or clears) a reason the live tab must defer a hand-over. */
export function markBusy(reason: BusyReason, busy: boolean): void {
  if (busy) busyReasons.add(reason);
  else busyReasons.delete(reason);
}

/** True while any reason is marked busy; passed to `startLiveTab` as `isBusy`. */
export function isBusy(): boolean {
  return busyReasons.size > 0;
}

// How long closeDatabases() waits for the closes with the worker still alive.
// After that it terminates the worker anyway, so a hung or dead worker never
// keeps the OPFS lock held; reload is the recovery (ADR-061, as in WCPOS). 3 s
// because the new tab shows "blocked" 13 s after the ack and the maximum
// deferral is 10 s (TallyUI live-tab doc, ADR-061 amendment 1).
export const PARK_CLOSE_LIMIT_MS = 3_000;

// True once a park's closes missed PARK_CLOSE_LIMIT_MS, reported by `storageNeedsReload()`.
// Sticky for the rest of this tab's life: RxDB never frees a name whose close()
// never finished, so a later, unrelated close succeeding does not undo this.
let needsReload = false;

/** True once a park's database closes outran `PARK_CLOSE_LIMIT_MS`: only a reload can reopen them. */
export function storageNeedsReload(): boolean {
  return needsReload;
}

/**
 * The park step for `LiveTabGate`'s `onPark`: closes every open database, up
 * to `PARK_CLOSE_LIMIT_MS`, then always terminates the shared storage worker.
 * Close first, terminate after: RxDB's remote `close()` sends `close` to the
 * worker and awaits the reply, and only frees the database name once that
 * finishes (`USED_DATABASE_NAMES`); terminating first would hang every close
 * and leave the names taken. Termination is what releases the OPFS pool, so
 * the next tab (or the next `live` in this tab) can open it. Never rejects.
 */
export async function closeDatabases(): Promise<void> {
  const closed = Promise.all([closeOrderStores(), closeProductCaches()]).then(() => true, () => true);
  const timedOut = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), PARK_CLOSE_LIMIT_MS));
  const inTime = await Promise.race([closed, timedOut]);
  if (!inTime) {
    needsReload = true;
    console.warn(`closeDatabases: closes did not settle within ${PARK_CLOSE_LIMIT_MS}ms; reload is now required.`);
  }
  terminateWebStorage();
}

// True once a store's open has failed with a StorageWorkerStartError (e.g. the opfs-sahpool pool
// held by another worker). Sticky: like a dead worker, reload is the only recovery.
const storageStartFailedSubject = new BehaviorSubject<boolean>(false);

/** The gate renders the blocked screen while this is true, whatever the coordinator state. */
export const storageStartFailed$: Observable<boolean> = storageStartFailedSubject.asObservable();

/** Marks that a store's open failed with a StorageWorkerStartError (`useOutbox`, `useReplicatedProducts`). */
export function reportStorageStartFailure(): void {
  storageStartFailedSubject.next(true);
}
