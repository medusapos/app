import type { CatalogueViewState, ProductSort } from '@tallyui/pos';
import type { SessionStorage } from './session';

// The cashier's catalogue view (grid or table, category, sort) per store, on this device. TallyUI's Catalogue
// normalizes whatever this returns, so the load only rejects what isn't a stored object.
const PREFIX = 'medusapos.catalogue.';

/** Tolerates a missing or corrupt value by returning undefined (Catalogue then keeps its defaults). */
export function loadCatalogueView(storage: SessionStorage | null, baseUrl: string): object | undefined {
  try {
    const value: unknown = JSON.parse(storage?.getItem(PREFIX + baseUrl) ?? 'null');
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined;
  } catch { return undefined; }
}

export function saveCatalogueView(storage: SessionStorage | null, baseUrl: string, state: object): void {
  storage?.setItem(PREFIX + baseUrl, JSON.stringify(state));
}

// v2's Product settings open on Name ascending and there is always a sort, so the app never holds TallyUI's
// `sort: null` (its default, a stored null, or the table header's third click).
export const DEFAULT_CATALOGUE_SORT: ProductSort = Object.freeze({ field: 'name', dir: 'asc' });

export function withCatalogueSort(state: CatalogueViewState): CatalogueViewState {
  return state.sort ? state : { ...state, sort: DEFAULT_CATALOGUE_SORT };
}
