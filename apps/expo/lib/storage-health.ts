import { BehaviorSubject, type Observable } from 'rxjs';
import {
  STORAGE_READ_WATCHDOG_MS, STORAGE_WRITE_STALL_MS, type StorageHealth, type StorageWatchdogOptions,
} from '@tallyui/database';

/**
 * TallyUI's watchdog defaults (ADR-061). In the e2e debug build only, the windows are shortened
 * so `e2e/storage.spec.ts` can reach `stalled` and `dead` in a reasonable test time; every other
 * build (including production) keeps TallyUI's own defaults.
 */
export const STORAGE_WATCHDOG_OPTIONS: StorageWatchdogOptions = process.env.EXPO_PUBLIC_E2E_DEBUG === '1'
  ? { writeStallMs: 1_000, readWatchdogMs: 1_500 }
  : { writeStallMs: STORAGE_WRITE_STALL_MS, readWatchdogMs: STORAGE_READ_WATCHDOG_MS };

type Status = StorageHealth['status'];
const RANK: Record<Status, number> = { ok: 0, stalled: 1, dead: 2 };

const statusBySource = new Map<Observable<StorageHealth>, Status>();
const overall = new BehaviorSubject<Status>('ok');
// Sticky once true: `StorageHealth`'s own dead branch unmounts the database that went dead (its
// `children`), which unregisters that source — recompute() must not let losing it read as recovery.
let everDead = false;

function recompute(): void {
  let worst: Status = 'ok';
  for (const status of statusBySource.values()) if (RANK[status] > RANK[worst]) worst = status;
  if (worst === 'dead') everDead = true;
  overall.next(everDead ? 'dead' : worst);
}

/** The worst status across every registered source ('dead' > 'stalled' > 'ok'); 'ok' when there are none. */
export const storageHealth$: Observable<Status> = overall.asObservable();

/** Registers a storage's `health$` as a source for `storageHealth$`; returns its unregister. */
export function watchStorageHealth(health$: Observable<StorageHealth>): () => void {
  const subscription = health$.subscribe((health) => {
    statusBySource.set(health$, health.status);
    recompute();
  });
  return () => {
    subscription.unsubscribe();
    statusBySource.delete(health$);
    recompute();
  };
}
