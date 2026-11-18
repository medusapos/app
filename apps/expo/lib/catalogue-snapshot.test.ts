// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { ProductTraits, TallyConnector } from '@tallyui/core';
import {
  catalogueStatus, publishCatalogue, sellableCatalogue, useCatalogueSnapshot, withdrawCatalogue, type CatalogueSnapshot,
} from './catalogue-snapshot';
import type { SyncState } from './use-replicated-products';

const traits = {} as ProductTraits;
const snapshot = (owner: CatalogueSnapshot['owner'], baseUrl: string): CatalogueSnapshot =>
  ({ owner, baseUrl, products: [], traits, currency: 'EUR', status: 'ready' });

afterEach(() => {
  act(() => { withdrawCatalogue('sale'); withdrawCatalogue('products'); });
});

describe('publishCatalogue and withdrawCatalogue', () => {
  it('keeps the Sale\'s catalogue over the area\'s own for the same store, not for another', () => {
    const { result } = renderHook(() => useCatalogueSnapshot());
    const sale = snapshot('sale', 'https://store.test');
    act(() => publishCatalogue(sale));
    act(() => publishCatalogue(snapshot('products', 'https://store.test')));
    expect(result.current).toBe(sale);
    const other = snapshot('products', 'https://other.test');
    act(() => publishCatalogue(other));
    expect(result.current).toBe(other);
  });

  it('withdraws only the owner\'s snapshot', () => {
    const { result } = renderHook(() => useCatalogueSnapshot());
    const sale = snapshot('sale', 'https://store.test');
    act(() => publishCatalogue(sale));
    act(() => withdrawCatalogue('products'));
    expect(result.current).toBe(sale);
    act(() => withdrawCatalogue('sale'));
    expect(result.current).toBeNull();
  });

  it('lets the Sale\'s catalogue replace the area\'s own', () => {
    const { result } = renderHook(() => useCatalogueSnapshot());
    act(() => publishCatalogue(snapshot('products', 'https://store.test')));
    const sale = snapshot('sale', 'https://store.test');
    act(() => publishCatalogue(sale));
    expect(result.current).toBe(sale);
  });
});

describe('catalogueStatus', () => {
  it.each<[number, SyncState, CatalogueSnapshot['status']]>([
    [0, 'syncing', 'loading'], [0, 'synced', 'ready'], [3, 'offline', 'ready'],
    [0, 'offline', 'error'], [0, 'error', 'error'], [0, 'connecting', 'loading'],
  ])('%i products, %s → %s', (count, state, status) => {
    expect(catalogueStatus(count, state)).toBe(status);
  });
});

describe('sellableCatalogue', () => {
  type Doc = { id: string; title: string; status: string; stock?: number };
  const connector = {
    traits: { product: {
      isSellable: (doc: Doc) => doc.status === 'published', getName: (doc: Doc) => doc.title,
    } },
    reconcile: { stock: { overlay: (doc: Doc, overlay: Map<string, unknown>) =>
      overlay.has(doc.id) ? { stock: overlay.get(doc.id) } : undefined } },
  } as unknown as TallyConnector;

  it('drops a product that is not sellable, sorts by name and lays reconciled stock over replicated stock', () => {
    const products: Doc[] = [
      { id: 'z', title: 'Zebra', status: 'published', stock: 1 },
      { id: 'd', title: 'Draft', status: 'draft' },
      { id: 'a', title: 'Apple', status: 'published', stock: 1 },
    ];
    const listed = sellableCatalogue(products, connector, new Map([['a', 7]])) as Doc[];
    expect(listed.map(({ id }) => id)).toEqual(['a', 'z']);
    expect(listed.map(({ stock }) => stock)).toEqual([7, 1]);
  });
});
