// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StorageWorkerStartError } from '@tallyui/storage-sqlite/web';
import { reportStorageStartFailure } from '../lib/live-tab';
import { useSessionOutbox } from '../lib/outbox-context';
import { StorageHealth } from '../components/storage-health';
import { clearOrderStoreOpenFailure, orderStoreOpenFailed$, type OrderStoreOpenFailure } from '../lib/storage-health';
import type { Session } from '../lib/session';
import { terminateWebStorage } from '../lib/web-storage';

// StorageHealth's open-failure prompt links out through expo-linking (Report a problem); the real
// module pulls in expo-modules-core, which needs Metro's __DEV__ global that vitest never sets.
vi.mock('expo-linking', () => ({ openURL: vi.fn().mockResolvedValue(true) }));

// A DM4-like failure from `addPosOrderCollection` (order-store.ts's one open path), armed for
// exactly the next call: real enough to drive `onOpenError` without reconstructing RxDB's own
// invalid-document DM4 (order-store.test.ts already covers a genuine one).
const dm4 = vi.hoisted(() => ({ armed: false }));
vi.mock('@tallyui/pos', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tallyui/pos')>();
  return {
    ...actual,
    addPosOrderCollection: vi.fn((...args: Parameters<typeof actual.addPosOrderCollection>) => {
      if (dm4.armed) { dm4.armed = false; return Promise.reject(Object.assign(new Error('COL19: invalid document'), { code: 'DM4' })); }
      return actual.addPosOrderCollection(...args);
    }),
  };
});
vi.mock('../lib/live-tab', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/live-tab')>();
  return { ...actual, reportStorageStartFailure: vi.fn(actual.reportStorageStartFailure) };
});

let outbox: ReturnType<typeof useSessionOutbox>;
let session: Session;
let sequence = 0;
function Harness({ session }: { session: Session | null }) {
  outbox = useSessionOutbox(session, 'register-1');
  return null;
}

beforeEach(() => {
  session = { baseUrl: `https://open-failure-${++sequence}.test`, email: 'cashier@test.com', token: 'token' };
  dm4.armed = false;
  vi.mocked(reportStorageStartFailure).mockClear();
});
afterEach(async () => {
  const db = outbox?.orders?.database;
  cleanup();
  if (db) await waitFor(() => expect(db.closed).toBe(true));
  // `orderStoreOpenFailed$` is a module singleton (like `storageStartFailed$`): left set, it would
  // leak this test's own failure into the next one.
  clearOrderStoreOpenFailure();
});

describe('StorageHealth: an order-store open failure other than a storage-worker start failure', () => {
  it('shows the blocking prompt with the heading, the code, Reload and Report', async () => {
    dm4.armed = true;
    render(<StorageHealth><Harness session={session} /></StorageHealth>);
    await waitFor(() => expect(screen.getByText("Saved sales can't be opened")).toBeTruthy());
    expect(screen.getByText(
      "Saved sales can't be opened on this device. Nothing has been deleted. Reload to try again, or report the problem.",
    )).toBeTruthy();
    expect(screen.getByText('Error code: DM4')).toBeTruthy();
    expect(screen.queryByText(/\(DM4\)/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Report a problem' })).toBeTruthy();
  });

  it('a storage-worker start failure still takes its own path, and this prompt does not show', async () => {
    const failure = new StorageWorkerStartError('opfs-sahpool is held by another worker');
    class FailingWorker { constructor() { throw failure; } }
    vi.stubGlobal('Worker', FailingWorker);
    vi.stubGlobal('navigator', { ...navigator, storage: { getDirectory: async () => ({}) } });
    try {
      render(<StorageHealth><Harness session={session} /></StorageHealth>);
      await waitFor(() => expect(reportStorageStartFailure).toHaveBeenCalled());
      expect(screen.queryByText("Saved sales can't be opened")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
      terminateWebStorage();
    }
  });

  it('clears the reported failure once a later open succeeds', async () => {
    // StorageHealth's own blocking (above) unmounts the outbox that would retry, exactly like the
    // sticky `dead` prompt: only a real Reload remounts it. Driven directly through the outbox
    // here, to prove the observable itself clears once `orders` goes non-null (a fresh backend,
    // as a real retry after Reload would be), not the always-blocked UI around it.
    let latest: OrderStoreOpenFailure = null;
    const subscription = orderStoreOpenFailed$.subscribe((value) => { latest = value; });
    try {
      dm4.armed = true;
      const view = render(<Harness session={session} />);
      await waitFor(() => expect(latest).toMatchObject({ code: 'DM4' }));
      view.rerender(<Harness session={{ ...session, baseUrl: `${session.baseUrl}/retry` }} />);
      await waitFor(() => expect(outbox.orders).not.toBeNull());
      expect(latest).toBeNull();
    } finally { subscription.unsubscribe(); }
  });
});
