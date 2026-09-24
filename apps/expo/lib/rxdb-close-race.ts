// RxDB 16.21.1's leader-election plugin closes the database's shared BroadcastChannel (its
// RxDatabase.close() override, in rx-storage-multiinstance.js) before its own preCloseRxDatabase
// hook calls elector.die(), which then posts a "death" message on that now-closed channel; the
// hook never awaits or catches that promise, so it can never be caught at a close() call site —
// only a page-level rejection handler can stop a browser from logging it. Interim until TallyUI
// orders the close properly upstream.
let closeRaceHandlerInstalled = false;

/** Call this once before (or around) closing a multi-instance database, on web only. */
export function suppressLeaderCloseRace(): void {
  if (closeRaceHandlerInstalled || typeof window === 'undefined') return;
  closeRaceHandlerInstalled = true;
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason as unknown;
    if (reason instanceof DOMException && reason.name === 'InvalidStateError'
      && reason.message === 'BroadcastChannel is closed.') event.preventDefault();
  });
}
