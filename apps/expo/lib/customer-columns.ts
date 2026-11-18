import { useCallback, useEffect, useState } from 'react';
import type { SessionStorage } from './session';

export type CustomerColumn = 'avatar' | 'firstName' | 'lastName' | 'email';
export const CUSTOMER_COLUMNS: { id: CustomerColumn; label: string }[] = [
  { id: 'avatar', label: 'Avatar' }, { id: 'firstName', label: 'First name' },
  { id: 'lastName', label: 'Last name' }, { id: 'email', label: 'Email' },
];
export type CustomerColumnSettings = Record<CustomerColumn, boolean>;
// v2's default shows every column.
export const DEFAULT_CUSTOMER_COLUMNS: CustomerColumnSettings = { avatar: true, firstName: true, lastName: true, email: true };
const PREFIX = 'medusapos.customer-columns.';

const anyShown = (settings: CustomerColumnSettings) => CUSTOMER_COLUMNS.some(({ id }) => settings[id]);

export function loadCustomerColumns(storage: SessionStorage | null, baseUrl: string): CustomerColumnSettings {
  try {
    const value: unknown = JSON.parse(storage?.getItem(PREFIX + baseUrl) ?? 'null');
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return DEFAULT_CUSTOMER_COLUMNS;
    const valid = Object.entries(value).every(([id, on]) =>
      CUSTOMER_COLUMNS.some((column) => column.id === id) && typeof on === 'boolean');
    const settings = { ...DEFAULT_CUSTOMER_COLUMNS, ...(value as Partial<CustomerColumnSettings>) };
    return valid && anyShown(settings) ? settings : DEFAULT_CUSTOMER_COLUMNS;
  } catch { return DEFAULT_CUSTOMER_COLUMNS; }
}

export function saveCustomerColumns(storage: SessionStorage | null, baseUrl: string, settings: CustomerColumnSettings): void {
  if (!anyShown(settings)) throw new Error('At least one column must show.');
  storage?.setItem(PREFIX + baseUrl, JSON.stringify(settings));
}

const listeners = new Set<() => void>();
export function useCustomerColumns(storage: SessionStorage | null, baseUrl: string): {
  settings: CustomerColumnSettings; save: (next: CustomerColumnSettings) => void; reset: () => void;
} {
  const [settings, setSettings] = useState(() => loadCustomerColumns(storage, baseUrl));
  useEffect(() => {
    const reload = () => setSettings(loadCustomerColumns(storage, baseUrl));
    reload(); listeners.add(reload);
    return () => { listeners.delete(reload); };
  }, [storage, baseUrl]);
  const save = useCallback((next: CustomerColumnSettings) => {
    saveCustomerColumns(storage, baseUrl, next); listeners.forEach((listener) => listener());
  }, [storage, baseUrl]);
  return { settings, save, reset: useCallback(() => save(DEFAULT_CUSTOMER_COLUMNS), [save]) };
}
