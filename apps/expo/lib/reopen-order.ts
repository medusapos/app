import { useSyncExternalStore } from 'react';
import type { StoreOrder } from '@tallyui/core';

/** The cart a reopened store order starts: its lines' catalogue entries and quantities, in order, and its customer. */
export type ReopenCart<Entry> = {
  lines: { entry: Entry; quantity: number }[];
  customer: { id: string; name: string; email?: string } | null;
};

/**
 * Orders' Reopen, Medusa's way: a new sale carrying the store order's lines and customer, priced from the till's
 * catalogue as any added product is; the placed order is never edited. A line without a variant (a custom line), or
 * whose variant the catalogue no longer sells, refuses the whole order, naming the first such line.
 */
export function buildReopenCart<Entry>(order: StoreOrder, lookup: (variantId: string) => Entry | undefined): ReopenCart<Entry> | string {
  const lines: ReopenCart<Entry>['lines'] = [];
  for (const line of order.lines) {
    const entry = line.variantId === undefined ? undefined : lookup(line.variantId);
    if (entry === undefined) return `Can't reopen: "${line.name}" is no longer for sale.`;
    lines.push({ entry, quantity: line.quantity });
  }
  const { id, name, email } = order.customer ?? {};
  // A customer the store gave no id is a guest here: setCustomer names a store customer by its id.
  const customer = id ? { id, name: name || email || '', ...(email ? { email } : {}) } : null;
  return { lines, customer };
}

// The hand-off from Orders to the Sale screen, which stays mounted under Orders: one pending order, taken once.
let pending: StoreOrder | null = null;
let pendingStoreUrl: string;
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/** Asks the Sale screen to reopen `order`; a later request replaces one not yet taken. */
export function requestReopen(order: StoreOrder, storeUrl: string): void { pending = order; pendingStoreUrl = storeUrl; notify(); }

/** The pending request, cleared: a second call returns null, so a request is applied once. */
export function takeReopen(storeUrl: string): StoreOrder | null {
  const order = pending;
  if (order) { pending = null; notify(); }
  return storeUrl === pendingStoreUrl ? order : null;
}

/** The pending request, re-rendering when one arrives or is taken. */
export function useReopenRequest(): StoreOrder | null {
  return useSyncExternalStore(subscribe, () => pending, () => null);
}
