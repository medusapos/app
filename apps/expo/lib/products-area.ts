import type { ProductTraits, StockLevel } from '@tallyui/core';
import { catalogueEntries, productCategories, variantPriceLabel } from '@tallyui/pos';
import type { SessionStorage } from './session';

export type ProductAreaRow = {
  id: string; name: string; sku: string; barcode: string; price: string; stock: string;
  stockStatus: StockLevel['status']; categories: string; categoryIds: string[];
  // The product's Medusa tag ids, shared by its variant rows.
  tagIds: string[];
  // The product's primary image (Medusa's thumbnail), shared by its variant rows.
  imageUrl?: string;
};

export type ProductTag = { id: string; value: string };

/** The Medusa product's `tags` ({ id, value }), read from the document: TallyUI's product traits have no tag accessor. */
export function productTags(doc: unknown): ProductTag[] {
  const tags = (doc as { tags?: unknown } | null)?.tags;
  if (!Array.isArray(tags)) return [];
  return tags.filter((tag): tag is ProductTag => typeof tag?.id === 'string' && tag.id !== ''
    && typeof tag.value === 'string' && tag.value !== '').map(({ id, value }) => ({ id, value }));
}

/** Every tag across the products, once per id (the first value seen), by value in natural order, then by id. */
export function listProductTags(products: readonly unknown[]): ProductTag[] {
  const byId = new Map<string, ProductTag>();
  for (const product of products) for (const tag of productTags(product)) if (!byId.has(tag.id)) byId.set(tag.id, tag);
  return [...byId.values()].sort((a, b) =>
    a.value.localeCompare(b.value, undefined, { numeric: true, sensitivity: 'base' }) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export const PRODUCTS_ADMIN_NOTE = 'Products are read-only here. Edit names, prices and stock in Medusa Admin.';
export const PRODUCTS_LOADING = 'Loading the catalogue…';
// Shown when the catalogue read failed without a message of its own.
export const PRODUCTS_LOAD_FAILED = 'The catalogue could not load.';
export const PRODUCTS_EMPTY = 'No products in the catalogue yet.';
export const PRODUCTS_NO_MATCH =(query: string) => `No products match “${query}”.`;
export const PRODUCTS_IN_STOCK_LABEL = 'In stock';
export const PRODUCTS_NONE_IN_STOCK = 'No products are in stock.';
export const PRODUCTS_TAGS_LABEL = 'Tags';
export const PRODUCTS_TAGS_SEARCH = 'Search Tags';
export const PRODUCTS_TAGS_NONE = 'No tags match.';
export const PRODUCTS_NONE_TAGGED = (tag: string) => `No products tagged “${tag}” match.`;
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
      barcode: variant.barcode ?? '',
      price: variantPriceLabel(variant, currency) ?? '—',
      stock: typeof variant.stock.quantity === 'number' ? variant.stock.quantity.toLocaleString() : STOCK_STATUS_LABELS[variant.stock.status],
      stockStatus: variant.stock.status,
      categories: categories.map((category) => category.name).join(', '),
      categoryIds: categories.map((category) => category.id),
      tagIds: productTags(product).map((tag) => tag.id),
      imageUrl: traits.getImageUrl(product),
    };
  });
}

/** Rows of products in the category; no category (null or '') keeps them all. */
export function filterProductAreaRowsByCategory(rows: ProductAreaRow[], categoryId: string | null): ProductAreaRow[] {
  if (!categoryId) return rows;
  return rows.filter((row) => row.categoryIds.includes(categoryId));
}

/** Rows of products carrying the tag; no tag (null or '') keeps them all. */
export function filterProductAreaRowsByTag(rows: ProductAreaRow[], tagId: string | null): ProductAreaRow[] {
  if (!tagId) return rows;
  return rows.filter((row) => row.tagIds.includes(tagId));
}

/** Rows whose name, SKU or barcode holds every term of the query, ignoring case (v2: "finds products by name, SKU or
 * barcode"); an empty query keeps them all. */
export function filterProductAreaRows(rows: ProductAreaRow[], query: string): ProductAreaRow[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return rows;
  return rows.filter((row) => {
    const name = row.name.toLowerCase();
    const sku = row.sku.toLowerCase();
    const barcode = row.barcode.toLowerCase();
    return terms.every((term) => name.includes(term) || sku.includes(term) || barcode.includes(term));
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

// The Products area's tag choice per store on this device, beside its category choice.
const TAG_PREFIX = 'medusapos.products-area-tag.';

/** The stored tag id, or null for none or a missing, corrupt or unreadable value. */
export function loadProductsAreaTag(storage: SessionStorage | null, baseUrl: string): string | null {
  try {
    const value: unknown = JSON.parse(storage?.getItem(TAG_PREFIX + baseUrl) ?? 'null');
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const tag = (value as { tag?: unknown }).tag;
    return typeof tag === 'string' && tag !== '' ? tag : null;
  } catch { return null; }
}

export function saveProductsAreaTag(storage: SessionStorage | null, baseUrl: string, tagId: string | null): void {
  try {
    storage?.setItem(TAG_PREFIX + baseUrl, JSON.stringify({ tag: tagId }));
  } catch (error) { console.warn('Could not save the Products tag:', error); }
}
