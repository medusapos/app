import { useCallback, useEffect, useRef, useState } from 'react';
import type { CommandWarning, Customer } from '@tallyui/core';
import type { CustomerSummary } from '@tallyui/pos';
import type { Session, SessionStorage } from './session';

// v2's "Default customer is cashier" is a store setting; Medusa has none, so it is kept per till per store.
const SWITCH_PREFIX = 'medusapos.default-customer-is-cashier.';
// The cashier is a Medusa admin user; the customer with their email is cached per store and cashier, so an offline till still starts on it.
const CACHE_PREFIX = 'medusapos.cashier-customer.';
const cacheKey = (baseUrl: string, email: string) => `${CACHE_PREFIX}${baseUrl}.${email.trim().toLowerCase()}`;
type Search = (query: string) => Promise<Customer[] | CustomerSummary[]>;
export type CashierCustomerStatus = 'off' | 'resolving' | 'found' | 'none' | 'offline';

export function loadDefaultCustomerIsCashier(storage: SessionStorage | null, baseUrl: string): boolean {
  try { return storage?.getItem(SWITCH_PREFIX + baseUrl) === 'true'; } catch { return false; }
}
export function saveDefaultCustomerIsCashier(storage: SessionStorage | null, baseUrl: string, on: boolean): void {
  if (on) storage?.setItem(SWITCH_PREFIX + baseUrl, 'true');
  else storage?.removeItem(SWITCH_PREFIX + baseUrl);
}
export function loadCashierCustomer(storage: SessionStorage | null, baseUrl: string, email: string): CustomerSummary | null {
  try {
    const value = JSON.parse(storage?.getItem(cacheKey(baseUrl, email)) ?? 'null') as Partial<CustomerSummary> | null;
    if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !value.id
      || typeof value.name !== 'string' || ('email' in value && typeof value.email !== 'string')) return null;
    return { id: value.id, name: value.name, ...(value.email !== undefined ? { email: value.email } : {}) };
  } catch { return null; }
}
function saveCashierCustomer(storage: SessionStorage | null, baseUrl: string, email: string, customer: CustomerSummary | null) {
  if (customer) storage?.setItem(cacheKey(baseUrl, email), JSON.stringify({ id: customer.id, name: customer.name, email: customer.email }));
  else storage?.removeItem(cacheKey(baseUrl, email));
}

/** Medusa's `q` is fuzzy over email and names, so only a result whose email is exactly the cashier's counts. */
export async function findCashierCustomer(search: Search, email: string): Promise<CustomerSummary | null> {
  const wanted = email.trim().toLowerCase();
  if (!wanted) return null;
  const match = (await search(email.trim())).find((customer) => customer.email?.trim().toLowerCase() === wanted);
  return match ? { id: match.id, name: match.name, email: match.email } : null;
}

const listeners = new Set<() => void>();
function notify() { listeners.forEach((listener) => listener()); }
export function forgetDeletedCashierCustomer(
  storage: SessionStorage | null, baseUrl: string, email: string, warnings: readonly CommandWarning[] | undefined,
): boolean {
  const customer = loadCashierCustomer(storage, baseUrl, email);
  if (!customer || !warnings?.some((warning) => warning.code === 'customer_ignored' && warning.customerId === customer.id)) return false;
  saveCashierCustomer(storage, baseUrl, email, null);
  notify();
  return true;
}

export function useCashierCustomer(
  storage: SessionStorage | null, session: Pick<Session, 'baseUrl' | 'email'>, search: Search | undefined, onError?: (error: unknown) => void,
): { on: boolean; setOn: (on: boolean) => void; customer: CustomerSummary | null; status: CashierCustomerStatus } {
  const { baseUrl, email } = session;
  const [on, setOnState] = useState(() => loadDefaultCustomerIsCashier(storage, baseUrl));
  const [cached, setCached] = useState(() => loadCashierCustomer(storage, baseUrl, email));
  const [result, setResult] = useState<Exclude<CashierCustomerStatus, 'off'>>('resolving');
  // The latest callbacks, so a new closure each render never searches again; only baseUrl, email and the switch do.
  const latest = useRef({ search, onError });
  latest.current = { search, onError };
  useEffect(() => {
    const reload = () => { setOnState(loadDefaultCustomerIsCashier(storage, baseUrl)); setCached(loadCashierCustomer(storage, baseUrl, email)); };
    reload();
    listeners.add(reload);
    return () => { listeners.delete(reload); };
  }, [storage, baseUrl, email]);
  const canSearch = search !== undefined;
  useEffect(() => {
    if (!on) return;
    const held = () => loadCashierCustomer(storage, baseUrl, email) ? 'offline' : 'none';
    if (!canSearch || !latest.current.search) { setResult(held()); return; }
    let active = true;
    setResult('resolving');
    findCashierCustomer(latest.current.search, email).then((found) => {
      if (!active) return;
      saveCashierCustomer(storage, baseUrl, email, found); notify();
      setResult(found ? 'found' : 'none');
    }, (error: unknown) => {
      if (!active) return;
      setResult(held());
      latest.current.onError?.(error);
    });
    return () => { active = false; };
  }, [storage, baseUrl, email, on, canSearch]);
  const setOn = useCallback((next: boolean) => { saveDefaultCustomerIsCashier(storage, baseUrl, next); notify(); }, [storage, baseUrl]);
  return { on, setOn, customer: on ? cached : null, status: on ? result : 'off' };
}
