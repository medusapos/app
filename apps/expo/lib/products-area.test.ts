import { describe, expect, it } from 'vitest';
import type { ProductTraits, VariantSummary } from '@tallyui/core';
import {
  filterProductAreaRows, filterProductAreaRowsByCategory, productAreaRows, STOCK_STATUS_DOTS, type ProductAreaRow,
} from './products-area';

type Doc = { id: string; title: string; variants: VariantSummary[]; categories?: { id: string; name: string }[] };
const traits = {
  getName: (doc: Doc) => doc.title,
  getVariantCount: (doc: Doc) => doc.variants.length,
  getVariants: (doc: Doc) => doc.variants,
  getCategories: (doc: Doc) => doc.categories ?? [],
  getCategoryNames: (doc: Doc) => (doc.categories ?? []).map((category) => category.name),
} as unknown as ProductTraits;
const eur = (amount: number) => [{ amount, currency: 'EUR', kind: 'base' as const }];

describe('productAreaRows', () => {
  it('gives one row per variant: name, SKU, price and stock quantity', () => {
    const shirt: Doc = { id: 'shirt', title: 'Shirt', variants: [
      { id: 'shirt-one', title: 'One size', sku: 'SHIRT', prices: eur(1250), stock: { status: 'in_stock', quantity: 7 } },
    ] };
    const mug: Doc = { id: 'mug', title: 'Mug', variants: [
      { id: 'mug-a', title: 'A', sku: 'MUG-A', prices: eur(500), stock: { status: 'in_stock', quantity: 3 } },
      { id: 'mug-b', title: 'B', sku: 'MUG-B', prices: eur(600), stock: { status: 'out_of_stock', quantity: 0 } },
    ] };
    expect(productAreaRows([shirt, mug], traits, 'EUR')).toEqual([
      { id: 'shirt-one', name: 'Shirt', sku: 'SHIRT', price: '€12.50', stock: '7', stockStatus: 'in_stock', categories: '', categoryIds: [] },
      { id: 'mug-a', name: 'Mug · A', sku: 'MUG-A', price: '€5.00', stock: '3', stockStatus: 'in_stock', categories: '', categoryIds: [] },
      { id: 'mug-b', name: 'Mug · B', sku: 'MUG-B', price: '€6.00', stock: '0', stockStatus: 'out_of_stock', categories: '',
        categoryIds: [] },
    ]);
  });

  it('labels untracked stock by status', () => {
    const statuses = ['in_stock', 'out_of_stock', 'backorder', 'unknown'] as const;
    const doc: Doc = { id: 'p', title: 'P', variants: statuses.map((status) => ({ id: status, title: status, sku: status,
      prices: eur(100), stock: { status } })) };
    expect(productAreaRows([doc], traits, 'EUR').map((row) => row.stock))
      .toEqual(['In stock', 'Out of stock', 'On backorder', '—']);
  });

  it('shows a missing SKU as empty and a missing price as a dash', () => {
    const doc: Doc = { id: 'p', title: 'Plain', variants: [{ id: 'v', prices: [], stock: { status: 'unknown' } }] };
    expect(productAreaRows([doc], traits, 'EUR')).toEqual([{ id: 'v', name: 'Plain', sku: '', price: '—', stock: '—',
      stockStatus: 'unknown', categories: '', categoryIds: [] }]);
  });

  it("gives each row its stock status and its product's categories", () => {
    const both: Doc = { id: 'b', title: 'Both', categories: [{ id: 'c1', name: 'Drinks' }, { id: 'c2', name: 'Food' }], variants: [
      { id: 'b-1', prices: eur(100), stock: { status: 'backorder' } },
    ] };
    const none: Doc = { id: 'n', title: 'None', variants: [{ id: 'n-1', prices: eur(100), stock: { status: 'out_of_stock', quantity: 0 } }] };
    expect(productAreaRows([both, none], traits, 'EUR').map(({ id, stockStatus, categories, categoryIds }) =>
      ({ id, stockStatus, categories, categoryIds }))).toEqual([
      { id: 'b-1', stockStatus: 'backorder', categories: 'Drinks, Food', categoryIds: ['c1', 'c2'] },
      { id: 'n-1', stockStatus: 'out_of_stock', categories: '', categoryIds: [] },
    ]);
  });
});

describe('filterProductAreaRows', () => {
  const row = (id: string, name: string, sku: string): ProductAreaRow => ({ id, name, sku, price: '€1.00', stock: '1',
    stockStatus: 'in_stock', categories: '', categoryIds: [] });
  const rows = [row('1', 'E2E product 1', 'E2E-1'), row('4a', 'E2E product 4 · A', 'E2E-4'), row('4b', 'E2E product 4 · B', 'E2E-4B')];

  it('returns the same array for a blank query', () => {
    expect(filterProductAreaRows(rows, '')).toBe(rows);
    expect(filterProductAreaRows(rows, '   ')).toBe(rows);
  });

  it('matches by name', () => {
    expect(filterProductAreaRows(rows, 'product 1').map((r) => r.id)).toEqual(['1']);
  });

  it('matches by SKU, ignoring case', () => {
    expect(filterProductAreaRows(rows, 'e2e-4b').map((r) => r.id)).toEqual(['4b']);
  });

  it('requires every term', () => {
    expect(filterProductAreaRows(rows, 'product 4').map((r) => r.id)).toEqual(['4a', '4b']);
    expect(filterProductAreaRows(rows, '4 B').map((r) => r.id)).toEqual(['4b']);
  });

  it('gives [] with no match', () => {
    expect(filterProductAreaRows(rows, 'hat')).toEqual([]);
  });
});

describe('filterProductAreaRowsByCategory', () => {
  const row = (id: string, categoryIds: string[]): ProductAreaRow => ({ id, name: id, sku: id, price: '€1.00', stock: '1',
    stockStatus: 'in_stock', categories: '', categoryIds });
  const rows = [row('1', ['drinks']), row('2', ['drinks', 'food']), row('3', ['food']), row('4', [])];

  it('keeps only rows in the category', () => {
    expect(filterProductAreaRowsByCategory(rows, 'food').map((r) => r.id)).toEqual(['2', '3']);
    expect(filterProductAreaRowsByCategory(rows, 'drinks').map((r) => r.id)).toEqual(['1', '2']);
    expect(filterProductAreaRowsByCategory(rows, 'hats')).toEqual([]);
  });

  it('returns the same array for no category', () => {
    expect(filterProductAreaRowsByCategory(rows, null)).toBe(rows);
    expect(filterProductAreaRowsByCategory(rows, '')).toBe(rows);
  });
});

describe('STOCK_STATUS_DOTS', () => {
  it("colours the dot as TallyUI's ProductStockBadge does", () => {
    expect(STOCK_STATUS_DOTS.in_stock).toBe('bg-success');
    expect(STOCK_STATUS_DOTS.out_of_stock).toBe('bg-destructive');
  });
});
