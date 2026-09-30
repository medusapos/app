import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { POS_CONNECTOR_ID } from './pos-connector';
import { resolveCapabilities, type ServerCapabilities } from '@tallyui/core';
import { exposeE2eHook } from './e2e-debug';
import { clearProductCache } from './product-cache';
import {
  clearSession, defaultStorage, loadSession, login, LoginError, refreshSession,
  saveSession, shouldRefresh, type Session,
} from './session';

type SessionContextValue = {
  session: Session | null;
  signIn(baseUrl: string, email: string, password: string): Promise<void>;
  signOut(): void;
  reportUnauthorized(): void;
  /** Merges a fresh capabilities read into the session (ADR-062): an inconclusive `undefined` keeps the stored value. */
  mergeCapabilities(fresh: ServerCapabilities | undefined): void;
  /**
   * Set by the sale screen (ADR 0015): `saving` defers every sign-out; `receipt` defers automatic ones; null releases
   * and runs a pending one. `run: false` (the screen's unmount) releases but keeps it pending for the next sale screen.
   */
  setSaleHold(hold: SaleHold, run?: boolean): void;
  /**
   * Set by OutboxProvider (ADR 0015): active while a save is in flight, deferring every sign-out; releasing runs a
   * pending one once the sale hold is clear too. `run: false` (the provider's unmount) releases but keeps it pending.
   */
  setSavesHold(active: boolean, run?: boolean): void;
  /** A sign-out is waiting for the sale hold or the saves hold to release. */
  signOutDeferred: boolean;
};
export type SaleHold = 'saving' | 'receipt' | null;
const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState(() => loadSession(defaultStorage()));
  const currentSession = useRef(session);
  const endSession = useCallback(() => {
    const ended = currentSession.current;
    clearSession(defaultStorage());
    currentSession.current = null;
    setSession(null);
    if (ended) void clearProductCache(POS_CONNECTOR_ID, ended.baseUrl);
  }, []);
  // Interim (ADR 0015): signing out unmounts the sale and closes the outbox, so a request while a sale or a save is held
  // is kept (one, with the token it was made under) and runs on release, unless the session was renewed meanwhile.
  const saleHold = useRef<SaleHold>(null);
  // Saves in flight (OutboxProvider): the outbox's close would wait on their writes, so every sign-out waits.
  const savesHold = useRef(false);
  const deferredToken = useRef<string | null>(null);
  const [signOutDeferred, setSignOutDeferred] = useState(false);
  const requestSignOut = useCallback((automatic: boolean) => {
    const hold = saleHold.current;
    if (!currentSession.current || !(hold === 'saving' || savesHold.current || (automatic && hold === 'receipt'))) return endSession();
    deferredToken.current = currentSession.current.token;
    setSignOutDeferred(true);
  }, [endSession]);
  const signOut = useCallback(() => requestSignOut(false), [requestSignOut]);
  const reportUnauthorized = useCallback(() => requestSignOut(true), [requestSignOut]);
  const release = useCallback((run: boolean) => {
    const token = deferredToken.current;
    // An unmount (a park, a blocking storage prompt) must not sign out: that would tear down under LiveTabGate's close.
    if (saleHold.current || savesHold.current || token === null || !run) return;
    deferredToken.current = null;
    setSignOutDeferred(false);
    if (currentSession.current?.token === token) endSession();
  }, [endSession]);
  const setSaleHold = useCallback((hold: SaleHold, run = true) => { saleHold.current = hold; release(run); }, [release]);
  const setSavesHold = useCallback((active: boolean, run = true) => { savesHold.current = active; release(run); }, [release]);
  // Debug builds only: lets the e2e request an automatic sign-out during a held save.
  useEffect(() => exposeE2eHook('ReportUnauthorized', reportUnauthorized), [reportUnauthorized]);
  // A renewed session (SignInAgain, a successful refresh) drops the pending request at once.
  useEffect(() => {
    if (deferredToken.current !== null && session?.token !== deferredToken.current) {
      deferredToken.current = null;
      setSignOutDeferred(false);
    }
  }, [session?.token]);
  const mergeCapabilities = useCallback((fresh: ServerCapabilities | undefined) => {
    const current = currentSession.current;
    const capabilities = resolveCapabilities(fresh, current?.capabilities);
    // Unchanged keeps the session's identity, so nothing that depends on it re-runs.
    if (!current || capabilities?.orderCreate === current.capabilities?.orderCreate) return;
    const next = { ...current, capabilities };
    saveSession(defaultStorage(), next);
    currentSession.current = next;
    setSession(next);
  }, []);
  async function signIn(baseUrl: string, email: string, password: string) {
    const next = await login(baseUrl, email, password);
    saveSession(defaultStorage(), next);
    currentSession.current = next;
    setSession(next);
  }
  const signedIn = session !== null;
  useEffect(() => {
    if (!signedIn) return;
    let active = true;
    async function check() {
      const current = currentSession.current;
      if (!current || !shouldRefresh(current.token, Date.now(), current.tokenExpiresAt)) return;
      try {
        const next = await refreshSession(current);
        if (!active || currentSession.current !== current) return;
        saveSession(defaultStorage(), next);
        currentSession.current = next;
        setSession(next);
      } catch (error) {
        if (active && currentSession.current === current && error instanceof LoginError && error.code === 'invalid_credentials') reportUnauthorized();
        // Offline and server failures preserve the session until the next check.
      }
    }
    void check();
    const timer = setInterval(check, 5 * 60 * 1000);
    return () => { active = false; clearInterval(timer); };
  }, [signedIn, reportUnauthorized]);

  return <SessionContext.Provider value={{ session, signIn, signOut, reportUnauthorized, mergeCapabilities, setSaleHold, setSavesHold,
    signOutDeferred }}>
    {children}
  </SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession must be used within SessionProvider.');
  return context;
}
