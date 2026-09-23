import { createContext, useContext, useState, type ReactNode } from 'react';
import { getRegisterId } from './register';
import { defaultStorage } from './session';
import { useSession } from './session-context';
import { useOutbox } from './use-outbox';

const OutboxContext = createContext<ReturnType<typeof useOutbox> | null>(null);

export function OutboxProvider({ children }: { children: ReactNode }) {
  const { session } = useSession();
  const [registerId] = useState(() => getRegisterId(defaultStorage()));
  const outbox = useOutbox(session, registerId);
  return <OutboxContext.Provider value={outbox}>{children}</OutboxContext.Provider>;
}

export function useOutboxContext() {
  const outbox = useContext(OutboxContext);
  if (!outbox) throw new Error('useOutboxContext must be used inside OutboxProvider');
  return outbox;
}
