import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { RxCollection } from 'rxdb';
import {
  bindRegister, getBoundRegisterId, observeRegister$, useRegisterSession, type PosOrder,
} from '@tallyui/pos';
import { version as appVersion } from '../package.json';
import { loadApprovers, VARIANCE_THRESHOLD_MINOR } from './approval';
import { registerCollections, type RegisterCollections } from './order-store';
import { defaultStorage } from './session';
import { useSession } from './session-context';

/**
 * The registers this till can bind to (ADR 0017): no server supplies a list yet (TallyUI registers c2), so every
 * backend offers this one default register. A server list replaces this constant later.
 */
export const DEFAULT_REGISTERS = [{ id: 'register-1', name: 'Register 1' }];

export type RegisterContextValue = {
  /** The one `useRegisterSession` for the signed-in backend: the sale screen and Job B's count screen share it. */
  register: ReturnType<typeof useRegisterSession>;
  /** The TallyUI register (drawer) this till is bound to, read from its `register` document: `null` when unbound,
   *  `undefined` until the store is open and read. Not `registerId`, which is this till's own device id. */
  boundRegisterId: string | null | undefined;
  registerName: string | null;
  registers: typeof DEFAULT_REGISTERS;
  bind(id: string): Promise<void>;
  /** The sale screen reports its tender here: counting and closing refuse while a sale is at tender. */
  setTenderInProgress(inProgress: boolean): void;
  /** The app's closes (ADR 0018), kept here so they outlive the cart view that started them (a phone's, #89 review). */
  close: CloseFlow;
};

export type CloseFlow = {
  /** `closeSession` through the app: its closure's sheet then shows. `fromCount`: the count's own close, whose failure
   *  is kept in `error` (the Finish closing card shows only its own run's error). */
  run(input: Parameters<CloseSession>[0], fromCount: boolean): ReturnType<CloseSession>;
  /** The closure whose ClosureSheet shows, until `dismiss`. */
  shown: string | null;
  dismiss(): void;
  /** Why the count's own close last failed, shown above the Finish closing card; cleared by the next close. */
  error: string;
};
type CloseSession = ReturnType<typeof useRegisterSession>['actions']['closeSession'];

type Bound = { collections: RegisterCollections; storeKey: string; id: string | null; name: string | null };

const RegisterContext = createContext<RegisterContextValue | null>(null);

/** Under OutboxProvider, over its open order store, whose database holds the register collections. */
export function RegisterProvider({ orders, children }: { orders: RxCollection<PosOrder> | null; children: ReactNode }) {
  const { session } = useSession();
  const storeKey = session?.baseUrl ?? '';
  const collections = useMemo(() => orders ? registerCollections(orders) : null, [orders]);
  const [bound, setBound] = useState<Bound | null>(null);
  useEffect(() => {
    if (!collections) return;
    const subscription = observeRegister$(collections.sessions).subscribe((document) => setBound({
      collections, storeKey, id: getBoundRegisterId(document, storeKey), name: document?.stores[storeKey]?.register_name ?? null,
    }));
    return () => subscription.unsubscribe();
  }, [collections, storeKey]);
  const current = bound?.collections === collections && bound?.storeKey === storeKey ? bound : null;
  const [tenderInProgress, setTenderInProgress] = useState(false);
  const register = useRegisterSession({
    sessions: collections?.sessions ?? null, movements: collections?.movements ?? null, closures: collections?.closures ?? null,
    orders,
    register: collections?.sessions ?? null,
    storeKey, registerId: current?.id ?? null, enabled: !!collections,
    actor: { id: session?.email ?? '', name: session?.email ?? '' },
    timezone: 'device', softwareVersion: appVersion, tenderInProgress,
    // Part B (ADR 0018): a close over the threshold needs an approver; blind counting stays off.
    varianceThreshold: VARIANCE_THRESHOLD_MINOR,
    // Cashier ids are their emails; an approver's id (a Medusa user id) resolves through the names kept at approval,
    // which a close resumed after a restart needs. Read at call time, so an approval just made is found.
    labels: { registerName: current?.name ?? undefined, resolveCashierName: (id) => loadApprovers(defaultStorage(), storeKey)[id] ?? id },
  });
  // Cleared when the store changes (on native nothing remounts this provider on a change of store or a sign-out), and
  // tagged with the store they were made in, as `bound` is, so the new store's first render, before the clear, shows
  // neither.
  const [shown, setShown] = useState<{ storeKey: string; id: string } | null>(null);
  const [closeError, setCloseError] = useState({ storeKey, message: '' });
  // Replaced on every change of store (A, signed out, A again included): a close started before it sets nothing.
  const storeTurn = useRef({});
  useLayoutEffect(() => {
    storeTurn.current = {};
    setShown(null);
    setCloseError({ storeKey, message: '' });
  }, [storeKey]);
  // TallyUI #175 runs one close per register (a second closeSession joins it) and exposes `register.closing`, with
  // which RegisterColumn keeps the count up during a close and shows its Finish closing card only for a closed
  // session that isn't closing: the app no longer masks anything.
  const close: CloseFlow = {
    async run(input, fromCount) {
      const turn = storeTurn.current;
      setCloseError({ storeKey, message: '' });
      try {
        const closure = await register.actions.closeSession(input);
        if (storeTurn.current === turn) setShown({ storeKey, id: closure.id });
        return closure;
      } catch (error) {
        // The card shows its own run's error itself; only the count's would otherwise go unseen.
        if (fromCount && storeTurn.current === turn) {
          setCloseError({ storeKey, message: error instanceof Error ? error.message : String(error) });
        }
        throw error;
      }
    },
    shown: shown?.storeKey === storeKey ? shown.id : null, dismiss: () => setShown(null),
    error: closeError.storeKey === storeKey ? closeError.message : '',
  };
  const value: RegisterContextValue = {
    register, boundRegisterId: current ? current.id : undefined, registerName: current?.name ?? null, registers: DEFAULT_REGISTERS,
    async bind(id) {
      const choice = DEFAULT_REGISTERS.find((entry) => entry.id === id);
      if (collections && choice) await bindRegister(collections.sessions, storeKey, choice);
    },
    setTenderInProgress,
    close,
  };
  return <RegisterContext.Provider value={value}>{children}</RegisterContext.Provider>;
}

export function useRegister(): RegisterContextValue {
  const value = useContext(RegisterContext);
  if (!value) throw new Error('useRegister must be used inside RegisterProvider');
  return value;
}
