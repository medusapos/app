import { useSyncExternalStore } from 'react';
import type { ProductTraits } from '@tallyui/core';

// The Sale screen owns the one replicated catalogue; the Products area only reads what it publishes here.
export type CatalogueSnapshot = { baseUrl: string; products: readonly unknown[]; traits: ProductTraits; currency: string };

let current: CatalogueSnapshot | null = null;
const listeners = new Set<() => void>();

export function publishCatalogue(snapshot: CatalogueSnapshot | null): void {
  current = snapshot;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const read = () => current;

export function useCatalogueSnapshot(): CatalogueSnapshot | null {
  return useSyncExternalStore(subscribe, read, read);
}
