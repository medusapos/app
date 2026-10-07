import { useCallback, useEffect, useState } from 'react';
import type { SessionStorage } from './session';

const PREFIX = 'medusapos.till-name.';
// ADR-078 ruling (Ask 1): a register v2 open's deviceName is 1-64 characters after trim.
const MAX_LENGTH = 64;

/** The trimmed name this till goes by at `baseUrl`, or `null` when none is set (or the stored value is unusable). */
export function loadTillName(storage: SessionStorage | null, baseUrl: string): string | null {
  try {
    const name = storage?.getItem(PREFIX + baseUrl)?.trim() ?? '';
    return name.length >= 1 && name.length <= MAX_LENGTH ? name : null;
  } catch { return null; }
}

/** An empty name clears the setting (back to the platform label); throws when the name is too long. */
export function saveTillName(storage: SessionStorage | null, baseUrl: string, name: string): void {
  const trimmed = name.trim();
  if (trimmed.length > MAX_LENGTH) throw new Error(`A till name can be at most ${MAX_LENGTH} characters.`);
  if (trimmed) storage?.setItem(PREFIX + baseUrl, trimmed);
  else storage?.removeItem(PREFIX + baseUrl);
}

// As scanner-settings.ts: a save notifies every mounted reader, so the register's next open sends the new name.
const listeners = new Set<() => void>();

/** This till's name, live: a `save` from any mounted caller updates every other one. */
export function useTillName(storage: SessionStorage | null, baseUrl: string): { tillName: string | null; save: (name: string) => void } {
  const [tillName, setTillName] = useState(() => loadTillName(storage, baseUrl));
  useEffect(() => {
    const reload = () => setTillName(loadTillName(storage, baseUrl));
    reload(); listeners.add(reload);
    return () => { listeners.delete(reload); };
  }, [storage, baseUrl]);
  const save = useCallback((name: string) => {
    saveTillName(storage, baseUrl, name); listeners.forEach((listener) => listener());
  }, [storage, baseUrl]);
  return { tillName, save };
}
