import { useSyncExternalStore } from 'react';
import type { ProductTraits, TallyConnector } from '@tallyui/core';
import { withStockOverlay } from '@tallyui/pos';
import type { SyncState } from './use-replicated-products';

// The catalogue the Products area shows: the Sale's, or, while no Sale holds one for the store, the area's own read
// (one database per store and pricing context, so never both at once).
export type CatalogueSnapshot = {
  owner: 'sale' | 'products'; baseUrl: string; products: readonly unknown[]; traits: ProductTraits; currency: string;
  status: 'loading' | 'ready' | 'error'; error?: string; retry?: () => void;
};

let current: CatalogueSnapshot | null = null;
const listeners = new Set<() => void>();

function set(snapshot: CatalogueSnapshot | null): void {
  current = snapshot;
  for (const listener of listeners) listener();
}

/** Replaces the current snapshot, except that the Sale's catalogue for the same store always wins over the area's own. */
export function publishCatalogue(snapshot: CatalogueSnapshot): void {
  if (snapshot.owner === 'products' && current?.owner === 'sale' && current.baseUrl === snapshot.baseUrl) return;
  set(snapshot);
}

/** Clears the current snapshot only when `owner` published it. */
export function withdrawCatalogue(owner: CatalogueSnapshot['owner']): void {
  if (current?.owner === owner) set(null);
}

/** Ready once anything is cached or the first pull is done; an error only while nothing is cached. */
export function catalogueStatus(count: number, state: SyncState): CatalogueSnapshot['status'] {
  if (count > 0 || state === 'synced') return 'ready';
  return state === 'error' || state === 'offline' ? 'error' : 'loading';
}

/** Reconciled stock over replicated stock (ADR-060), sellable products only, sorted by name: what the Sale lists. */
export function sellableCatalogue(products: readonly unknown[], connector: TallyConnector, overlay: Map<string, unknown> | undefined) {
  const traits = connector.traits.product;
  return products.map((doc) => withStockOverlay(doc, connector.reconcile?.stock, overlay))
    .filter(traits.isSellable).sort((a, b) => traits.getName(a).localeCompare(traits.getName(b)));
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const read = () => current;

export function useCatalogueSnapshot(): CatalogueSnapshot | null {
  return useSyncExternalStore(subscribe, read, read);
}
