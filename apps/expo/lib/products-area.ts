import type { ProductTraits, StockLevel } from '@tallyui/core';
import { catalogueEntries, variantPriceLabel } from '@tallyui/pos';

export type ProductAreaRow = { id: string; name: string; sku: string; price: string; stock: string };

export const PRODUCTS_ADMIN_NOTE = 'Products are read-only here. Edit names, prices and stock in Medusa Admin.';
export const PRODUCTS_NOT_LOADED = 'The catalogue loads with the Sale. Open the Sale, then come back.';
export const PRODUCTS_EMPTY = 'No products in the catalogue yet.';
export const PRODUCTS_NO_MATCH =(query: string) => `No products match “${query}”.`;

const STOCK_LABELS: Record<StockLevel['status'], string> = {
  in_stock: 'In stock', out_of_stock: 'Out of stock', backorder: 'On backorder', unknown: '—',
};

/** One row per sellable variant, as the Sale's catalogue lists them. */
export function productAreaRows(products: readonly unknown[], traits: ProductTraits, currency: string): ProductAreaRow[] {
  return catalogueEntries([...products], traits).map(({ product, variant }) => {
    const name = traits.getName(product);
    return {
      id: variant.id,
      name: traits.getVariantCount(product) > 1 && variant.title ? `${name} · ${variant.title}` : name,
      sku: variant.sku ?? '',
      price: variantPriceLabel(variant, currency) ?? '—',
      stock: typeof variant.stock.quantity === 'number' ? variant.stock.quantity.toLocaleString() : STOCK_LABELS[variant.stock.status],
    };
  });
}

/** Rows whose name or SKU holds every term of the query, ignoring case; an empty query keeps them all. */
export function filterProductAreaRows(rows: ProductAreaRow[], query: string): ProductAreaRow[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return rows;
  return rows.filter((row) => {
    const name = row.name.toLowerCase();
    const sku = row.sku.toLowerCase();
    return terms.every((term) => name.includes(term) || sku.includes(term));
  });
}
