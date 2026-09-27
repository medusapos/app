import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { isStorageWorkerFailure } from '@tallyui/database';
import { createHttpCommandTransport, getDeviceId, useOrderOutbox, type UseOrderOutboxResult } from '@tallyui/pos';
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
    onOpenError: (error) => { if (isStorageWorkerFailure(error)) reportStorageStartFailure(); else reportOrderStoreOpenFailure(error); },
  });
  useEffect(() => { if (outbox.orders) clearOrderStoreOpenFailure(); }, [outbox.orders]);
  return outbox;
}

const OutboxContext = createContext<UseOrderOutboxResult | null>(null);

export function OutboxProvider({ children }: { children: ReactNode }) {
  const { session } = useSession();
  const [registerId] = useState(() => getDeviceId(defaultStorage(), REGISTER_ID_KEY));
  const outbox = useSessionOutbox(session, registerId);
  return <OutboxContext.Provider value={outbox}>
    {children}
  </OutboxContext.Provider>;
}

export function useOutboxContext() {
  const outbox = useContext(OutboxContext);
  if (!outbox) throw new Error('useOutboxContext must be used inside OutboxProvider');
  return outbox;
}
