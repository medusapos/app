import { useState, useEffect, createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import { getDatabase } from '../database';
import type { TallyDatabase } from '@tallyui/database';

const DatabaseContext = createContext<TallyDatabase | null>(null);

export function DatabaseProvider({ db, children }: { db: TallyDatabase; children: ReactNode }) {
  return <DatabaseContext.Provider value={db}>{children}</DatabaseContext.Provider>;
}

export function useDatabaseContext(): TallyDatabase {
  const db = useContext(DatabaseContext);
  if (!db) throw new Error('useDatabaseContext must be used within DatabaseProvider');
  return db;
}

export function useDatabase() {
  const [db, setDb] = useState<TallyDatabase | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    getDatabase().then(setDb).catch(setError);
  }, []);

  return { db, isLoading: !db && !error, error };
}
