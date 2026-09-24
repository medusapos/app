import { useEffect, useRef, useState } from 'react';
import type { RxCollection } from 'rxdb';
import { createHttpCommandTransport, createOrderOutbox, type OutboxState, type PosOrder } from '@tallyui/pos';
import type { Session } from './session';
import { openOrderStore } from './order-store';
import { authHeaders } from './pos-connector';

const idle: OutboxState = { pending: 0, sending: false };

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
      if (!active) { await store.close(); return; }
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
      if (opened && opened.baseUrl === baseUrl) await opened.outbox.flush();
    },
    async requeue(orderIds) {
      const opened = current.current;
      return opened && opened.baseUrl === baseUrl ? opened.outbox.requeue(orderIds) : 0;
    },
    async record(posOrder) {
      const opened = current.current;
      if (!opened || opened.baseUrl !== baseUrl) throw openingError.current ?? new Error('Orders are not ready.');
      await opened.orders.insert(posOrder);
      if (current.current === opened) void opened.outbox.flush();
    },
  };
}
