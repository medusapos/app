// Interim workaround (front-desk decision, 2026-09-24): RxDB 16.21.1's leader-election plugin
// overrides RxDatabase.close() to close the shared BroadcastChannel (rx-storage-multiinstance.js)
// before its own preCloseRxDatabase hook calls elector.die(), which then tries to post a "death"
// message on that now-closed channel; the hook never awaits or catches that promise, so it always
// surfaces as a process-level unhandled rejection whenever a multiInstance database is closed —
// which every test that opens a web/multiInstance order-store or product-cache db does on
// unmount or store-switch. Drop this once TallyUI orders the close properly upstream.
//
// Vitest's own unhandledRejection reporting (vitest/dist/chunks/startModuleRunner.js's
// listenForErrors) steps aside entirely once a second listener is registered on the process,
// assuming "handled by user code" — so anything other than this one known error is rethrown here,
// which Node escalates to uncaughtException instead, where this file adds no extra listener, so
// vitest's own (sole) handler still reports and fails the run on a genuine problem.
process.on('unhandledRejection', (reason) => {
  if (reason instanceof DOMException && reason.name === 'InvalidStateError'
    && reason.message === 'BroadcastChannel is closed.') return;
  throw reason instanceof Error ? reason : new Error(String(reason));
});
