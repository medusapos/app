import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { isStorageWorkerFailure } from '@tallyui/database';
import {
  createHttpCommandTransport, getDeviceId, PosOrderOpenClosedError, useOrderOutbox, type PosOrder, type UseOrderOutboxResult,
} from '@tallyui/pos';
import { markBusy, reportStorageStartFailure } from './live-tab';
import { openOrderStore } from './order-store';
import { authHeaders } from './pos-connector';
import { defaultStorage, REGISTER_ID_KEY, type Session } from './session';
import { useSession } from './session-context';
import { clearOrderStoreOpenFailure, reportOrderStoreOpenFailure } from './storage-health';

/** TallyUI's outbox, wired to this app: one order store per backend, the HTTP transport with the session's current token. */
export function useSessionOutbox(session: Session | null, registerId: string): UseOrderOutboxResult {
  const tokenRef = useRef(session?.token);
  tokenRef.current = session?.token;
  const outbox = useOrderOutbox({
    storeKey: session?.baseUrl ?? null,
    open: openOrderStore,
    // Headers are read per request, so a token refresh keeps the open store and its outbox.
    transport: (baseUrl) => createHttpCommandTransport({ baseUrl, getHeaders: () => authHeaders(tokenRef.current ?? '') }),
    deviceId: registerId,
    onBusy: (busy) => markBusy('outbox', busy),
    onOpenError: (error) => {
      if (isStorageWorkerFailure(error)) reportStorageStartFailure();
      // Defensive: a close during the open, or (TallyUI #155) a close that gives up waiting on a stuck
      // migration. Either way no order is lost; the outbox has no store until the store key changes or the
      // app reloads, and that open retries. This app doesn't do that today:
      // openOrderStore hands out close() only once the open resolves, and closeOrderStores waits on the open.
      else if (error instanceof PosOrderOpenClosedError) return;
      else reportOrderStoreOpenFailure(error);
    },
  });
  useEffect(() => { if (outbox.orders) clearOrderStoreOpenFailure(); }, [outbox.orders]);
  return outbox;
}

/** The outbox, with `savesInFlight`: how many `record` calls haven't settled yet. */
export type OutboxContextValue = UseOrderOutboxResult & { savesInFlight: number };
const OutboxContext = createContext<OutboxContextValue | null>(null);

export function OutboxProvider({ children }: { children: ReactNode }) {
  const { session } = useSession();
  const [registerId] = useState(() => getDeviceId(defaultStorage(), REGISTER_ID_KEY));
  const outbox = useSessionOutbox(session, registerId);
  // Counted here, not in the sale screen, so a remount can't forget one (#85 review). A save abandoned by Continue
  // can still hang in its insert, and RxDB's close waits on that write, so the sale screen holds sign-out until it settles.
  const [savesInFlight, setSavesInFlight] = useState(0);
  const latestRecord = useRef(outbox.record);
  latestRecord.current = outbox.record;
  // Stable: useSale gets it as onSaleCompleted.
  const record = useCallback(async (posOrder: PosOrder) => {
    setSavesInFlight((count) => count + 1);
    try { await latestRecord.current(posOrder); } finally { setSavesInFlight((count) => count - 1); }
  }, []);
  return <OutboxContext.Provider value={{ ...outbox, record, savesInFlight }}>
    {children}
  </OutboxContext.Provider>;
}

export function useOutboxContext() {
  const outbox = useContext(OutboxContext);
  if (!outbox) throw new Error('useOutboxContext must be used inside OutboxProvider');
  return outbox;
}
