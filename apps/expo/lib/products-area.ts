import type { ProductTraits, StockLevel } from '@tallyui/core';
import { catalogueEntries, productCategories, variantPriceLabel } from '@tallyui/pos';

export type ProductAreaRow = {
  id: string; name: string; sku: string; price: string; stock: string;
  stockStatus: StockLevel['status']; categories: string; categoryIds: string[];
};

export const PRODUCTS_ADMIN_NOTE = 'Products are read-only here. Edit names, prices and stock in Medusa Admin.';
export const PRODUCTS_NOT_LOADED = 'The catalogue loads with the Sale. Open the Sale, then come back.';
export const PRODUCTS_EMPTY = 'No products in the catalogue yet.';
export const PRODUCTS_NO_MATCH =(query: string) => `No products match “${query}”.`;

export const STOCK_STATUS_LABELS: Record<StockLevel['status'], string> = {
  in_stock: 'In stock', out_of_stock: 'Out of stock', backorder: 'On backorder', unknown: '—',
};

/** The status dot's colour, as TallyUI's `ProductStockBadge` colours its dot. */
export const STOCK_STATUS_DOTS: Record<StockLevel['status'], string> = {
  in_stock: 'bg-success', out_of_stock: 'bg-destructive', backorder: 'bg-warning', unknown: 'bg-muted',
};

/** One row per sellable variant, as the Sale's catalogue lists them. */
export function productAreaRows(products: readonly unknown[], traits: ProductTraits, currency: string): ProductAreaRow[] {
  return catalogueEntries([...products], traits).map(({ product, variant }) => {
    const name = traits.getName(product);
    const categories = productCategories(product, traits);
    return {
      id: variant.id,
      name: traits.getVariantCount(product) > 1 && variant.title ? `${name} · ${variant.title}` : name,
      sku: variant.sku ?? '',
      price: variantPriceLabel(variant, currency) ?? '—',
      stock: typeof variant.stock.quantity === 'number' ? variant.stock.quantity.toLocaleString() : STOCK_STATUS_LABELS[variant.stock.status],
      stockStatus: variant.stock.status,
      categories: categories.map((category) => category.name).join(', '),
      categoryIds: categories.map((category) => category.id),
    };
  });
}

/** Rows of products in the category; no category (null or '') keeps them all. */
export function filterProductAreaRowsByCategory(rows: ProductAreaRow[], categoryId: string | null): ProductAreaRow[] {
  if (!categoryId) return rows;
  return rows.filter((row) => row.categoryIds.includes(categoryId));
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
