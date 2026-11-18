import type { ProductTraits, StockLevel } from '@tallyui/core';
import { catalogueEntries, productCategories, variantPriceLabel } from '@tallyui/pos';
import type { SessionStorage } from './session';

export type ProductAreaRow = {
  id: string; name: string; sku: string; price: string; stock: string;
  stockStatus: StockLevel['status']; categories: string; categoryIds: string[];
};

export const PRODUCTS_ADMIN_NOTE = 'Products are read-only here. Edit names, prices and stock in Medusa Admin.';
export const PRODUCTS_LOADING = 'Loading the catalogue…';
// Shown when the catalogue read failed without a message of its own.
export const PRODUCTS_LOAD_FAILED = 'The catalogue could not load.';
export const PRODUCTS_EMPTY = 'No products in the catalogue yet.';
export const PRODUCTS_NO_MATCH =(query: string) => `No products match “${query}”.`;
export const PRODUCTS_IN_STOCK_LABEL = 'In stock';
export const PRODUCTS_NONE_IN_STOCK = 'No products are in stock.';
// The footer under the list: rows shown after the search and chips, of the sellable catalogue's rows.
export const PRODUCTS_SHOWING = (shown: number, total: number) => `Showing ${shown} of ${total}`;

export const STOCK_STATUS_LABELS: Record<StockLevel['status'], string> = {
  in_stock: 'In stock', out_of_stock: 'Out of stock', backorder: 'On backorder', unknown: '—',
};

/** The status dot's colour, as TallyUI's `ProductStockBadge` colours its dot. */
export const STOCK_STATUS_DOTS: Record<StockLevel['status'], string> = {
  in_stock: 'bg-success', out_of_stock: 'bg-destructive', backorder: 'bg-warning', unknown: 'bg-muted',
};

/** The phone row's stock line: "<quantity> · <status>" when the variant has a quantity, else the status alone. */
export function productAreaStockLine(row: ProductAreaRow): string {
  const label = STOCK_STATUS_LABELS[row.stockStatus];
  return row.stock === label ? label : `${row.stock} · ${label}`;
}

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

/** Only rows in stock when `inStockOnly`; off returns the same array. */
export function filterProductAreaRowsInStock(rows: ProductAreaRow[], inStockOnly: boolean): ProductAreaRow[] {
  if (!inStockOnly) return rows;
  return rows.filter((row) => row.stockStatus === 'in_stock');
}

// The Products area's category choice per store on this device, kept apart from the Sale's catalogue view.
const CATEGORY_PREFIX = 'medusapos.products-area.';

/** The stored category id, or null for All or a missing, corrupt or unreadable value. */
export function loadProductsAreaCategory(storage: SessionStorage | null, baseUrl: string): string | null {
  try {
    const value: unknown = JSON.parse(storage?.getItem(CATEGORY_PREFIX + baseUrl) ?? 'null');
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const category = (value as { category?: unknown }).category;
    return typeof category === 'string' && category !== '' ? category : null;
  } catch { return null; }
}

export function saveProductsAreaCategory(storage: SessionStorage | null, baseUrl: string, categoryId: string | null): void {
  try {
    storage?.setItem(CATEGORY_PREFIX + baseUrl, JSON.stringify({ category: categoryId }));
  } catch (error) { console.warn('Could not save the Products category:', error); }
}
