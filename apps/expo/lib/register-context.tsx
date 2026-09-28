import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { RxCollection } from 'rxdb';
import {
  bindRegister, getBoundRegisterId, observeRegister$, useRegisterSession, type PosOrder,
} from '@tallyui/pos';
import { version as appVersion } from '../package.json';
import { registerCollections, type RegisterCollections } from './order-store';
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
};

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
  });
  const value: RegisterContextValue = {
    register, boundRegisterId: current ? current.id : undefined, registerName: current?.name ?? null, registers: DEFAULT_REGISTERS,
    async bind(id) {
      const choice = DEFAULT_REGISTERS.find((entry) => entry.id === id);
      if (collections && choice) await bindRegister(collections.sessions, storeKey, choice);
    },
    setTenderInProgress,
  };
  return <RegisterContext.Provider value={value}>{children}</RegisterContext.Provider>;
}

export function useRegister(): RegisterContextValue {
  const value = useContext(RegisterContext);
  if (!value) throw new Error('useRegister must be used inside RegisterProvider');
  return value;
}
