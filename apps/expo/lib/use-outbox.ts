import { useEffect, useRef, useState } from 'react';
import type { RxCollection } from 'rxdb';
import { createHttpCommandTransport, createOrderOutbox, type OutboxState, type PosOrder } from '@tallyui/pos';
import type { Session } from './session';
import { openOrderStore } from './order-store';
import { authHeaders } from './pos-connector';
import { suppressLeaderCloseRace } from './rxdb-close-race';

const idle: OutboxState = { pending: 0, sending: false };
const FLUSH_LOCAL_DOC_ID = 'tally-outbox-flush';

/**
 * RxDB's own write conflict when a follower's flush() forward (database.upsertLocal on the shared
 * `tally-outbox-flush` doc) loses a race to a sibling call for the same, not-yet-created doc: the
 * raw storage error `{ isError: true, status: 409, documentId }` (rx-storage-helper.js), or once
 * the doc exists, RxDB's own `RxError('CONFLICT', { id })`. Either way the leader still learned to
 * flush from whichever call won, so this specific conflict is not a real failure.
 */
function isFlushForwardConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const err = error as { isError?: unknown; status?: unknown; documentId?: unknown;
    code?: unknown; parameters?: { id?: unknown } };
  if (err.isError === true && err.status === 409 && err.documentId === FLUSH_LOCAL_DOC_ID) return true;
  return err.code === 'CONFLICT' && err.parameters?.id === FLUSH_LOCAL_DOC_ID;
}

export function useOutbox(session: Session | null, registerId: string): {
  orders: RxCollection<PosOrder> | null; state: OutboxState; recent: PosOrder[];
  record(posOrder: PosOrder): Promise<void>;
  flush(): Promise<void>;
  requeue(orderIds?: string[]): Promise<number>;
} {
  const baseUrl = session?.baseUrl;
  const tokenRef = useRef(session?.token);
  tokenRef.current = session?.token;
  const current = useRef<{
    baseUrl: string; orders: RxCollection<PosOrder>; outbox: ReturnType<typeof createOrderOutbox>;
  } | null>(null);
  const openingError = useRef<unknown>(null);
  const [orders, setOrders] = useState<RxCollection<PosOrder> | null>(null);
  const [state, setState] = useState<OutboxState>(idle);
  const [recent, setRecent] = useState<PosOrder[]>([]);

  useEffect(() => {
    let active = true;
    let dispose: (() => void) | undefined;
    openingError.current = null;
    setOrders(null); setState(idle); setRecent([]);
    if (!baseUrl) return;
    void openOrderStore(baseUrl).then(async (store) => {
      if (!active) { suppressLeaderCloseRace(); await store.close(); return; }
      const outbox = createOrderOutbox({ collection: store.orders, deviceId: registerId,
        transport: createHttpCommandTransport({ baseUrl,
          getHeaders: () => authHeaders(tokenRef.current ?? ''),
        }),
      });
      current.current = { baseUrl, orders: store.orders, outbox };
      const status = outbox.state$.subscribe(setState);
      const history = store.orders.find({ sort: [{ createdAt: 'desc' }], limit: 50 }).$.subscribe((docs) => {
        setRecent(docs.map((doc) => doc.toMutableJSON()));
      });
      dispose = () => {
        outbox.stop(); status.unsubscribe(); history.unsubscribe();
        suppressLeaderCloseRace();
        void store.close();
      };
      setOrders(store.orders);
      outbox.start();
    }).catch((error: unknown) => { if (active) openingError.current = error; });
    return () => { active = false; current.current = null; dispose?.(); };
  }, [baseUrl, registerId]);

  const ready = current.current?.baseUrl === baseUrl && !!baseUrl;
  return { orders: ready ? orders : null, state: ready ? state : idle, recent: ready ? recent : [],
    async flush() {
      const opened = current.current;
      // A follower's flush() only forwards to the leader via a shared local doc; a concurrent
      // forward can lose a write race even though a sibling call still notified the leader
      // (TallyUI #42's non-leader branch has no request coalescing, unlike the leader's own run()).
      if (opened && opened.baseUrl === baseUrl) await opened.outbox.flush().catch((error: unknown) => {
        if (!isFlushForwardConflict(error)) throw error;
      });
    },
    async requeue(orderIds) {
      const opened = current.current;
      return opened && opened.baseUrl === baseUrl ? opened.outbox.requeue(orderIds) : 0;
    },
    async record(posOrder) {
      const opened = current.current;
      if (!opened || opened.baseUrl !== baseUrl) throw openingError.current ?? new Error('Orders are not ready.');
      await opened.orders.insert(posOrder);
      // The outbox's own start() already flushes on this insert; this nudge is belt-and-braces,
      // so a lost follower-forward race (see flush() above) is not this call's to surface.
      if (current.current === opened) void opened.outbox.flush().catch((error: unknown) => {
        if (!isFlushForwardConflict(error)) throw error;
      });
    },
  };
}
