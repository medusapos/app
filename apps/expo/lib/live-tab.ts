import { closeOrderStores } from './order-store';
import { closeProductCaches } from './product-cache';

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

/**
 * The park step for `LiveTabGate`'s `onPark`: closes every open database so
 * the next tab can open them fresh. A storage worker (none on Dexie today)
 * would be terminated here synchronously, before any await, so a frozen page
 * still released it.
 */
export async function closeDatabases(): Promise<void> {
  await Promise.all([closeOrderStores(), closeProductCaches()]);
}
