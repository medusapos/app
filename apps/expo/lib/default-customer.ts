import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CommandWarning } from '@tallyui/core';
import type { CustomerSummary } from '@tallyui/pos';
import type { SessionStorage } from './session';

// v2 keeps this as a store setting; Medusa has none, so it is kept per till per store.
const PREFIX = 'medusapos.default-customer.';
export function loadDefaultCustomer(storage: SessionStorage | null, baseUrl: string): CustomerSummary | null {
  try {
    const value = JSON.parse(storage?.getItem(PREFIX + baseUrl) ?? 'null') as Partial<CustomerSummary> | null;
    if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !value.id
      || typeof value.name !== 'string' || ('email' in value && typeof value.email !== 'string')) return null;
    return { id: value.id, name: value.name, ...(value.email !== undefined ? { email: value.email } : {}) };
  } catch { return null; }
}
export function saveDefaultCustomer(storage: SessionStorage | null, baseUrl: string, customer: CustomerSummary | null): void {
  if (customer) storage?.setItem(PREFIX + baseUrl, JSON.stringify({ id: customer.id, name: customer.name, email: customer.email }));
  else storage?.removeItem(PREFIX + baseUrl);
}

const listeners = new Set<() => void>();
function notify() { listeners.forEach((listener) => listener()); }
export function forgetDeletedDefaultCustomer(
  storage: SessionStorage | null, baseUrl: string, warnings: readonly CommandWarning[] | undefined,
): boolean {
  const customer = loadDefaultCustomer(storage, baseUrl);
  if (!warnings?.some((warning) => warning.code === 'customer_ignored' && warning.customerId === customer?.id)) return false;
  saveDefaultCustomer(storage, baseUrl, null);
  notify();
  return true;
}
export function useDefaultCustomer(storage: SessionStorage | null, baseUrl: string): {
  customer: CustomerSummary | null; save: (c: CustomerSummary | null) => void;
} {
  const initial = useMemo(() => loadDefaultCustomer(storage, baseUrl), [storage, baseUrl]);
  const [customer, setCustomer] = useState(initial);
  useEffect(() => {
    setCustomer(initial);
    const reload = () => setCustomer(loadDefaultCustomer(storage, baseUrl));
    listeners.add(reload);
    return () => { listeners.delete(reload); };
  }, [storage, baseUrl, initial]);
  const save = useCallback((c: CustomerSummary | null) => {
    saveDefaultCustomer(storage, baseUrl, c); notify();
  }, [storage, baseUrl]);
  return { customer, save };
}
