import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { medusaConnector } from '@tallyui/connector-medusa';
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
};
const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState(() => loadSession(defaultStorage()));
  const currentSession = useRef(session);
  const signOut = useCallback(() => {
    const ended = currentSession.current;
    clearSession(defaultStorage());
    currentSession.current = null;
    setSession(null);
    if (ended) void clearProductCache(medusaConnector.id, ended.baseUrl);
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
        if (active && currentSession.current === current && error instanceof LoginError && error.code === 'invalid_credentials') signOut();
        // Offline and server failures preserve the session until the next check.
      }
    }
    void check();
    const timer = setInterval(check, 5 * 60 * 1000);
    return () => { active = false; clearInterval(timer); };
  }, [signedIn, signOut]);

  return <SessionContext.Provider value={{ session, signIn, signOut, reportUnauthorized: signOut }}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession must be used within SessionProvider.');
  return context;
}
