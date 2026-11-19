import { formatMoney, resolvePrice, resolvePriceRange, type Money, type ProductTraits, type StockLevel } from '@tallyui/core';
import { catalogueEntries, productCategories, sortProducts, type ProductSort, type ProductSortValue } from '@tallyui/pos';
import type { SessionStorage } from './session';

export type ProductAreaRow = {
  id: string; name: string; sku: string; barcode: string; price: string; stock: string;
  stockStatus: StockLevel['status']; categories: string; categoryIds: string[];
  // v2's Regular and Sale price: the price before a Medusa sale price list, and the sale price ('' without a sale).
  regularPrice: string; salePrice: string; onSale: boolean;
  // The product's Medusa tag ids, shared by its variant rows.
  tagIds: string[];
  // The product's Medusa product collection id (null without one), shared by its variant rows.
  collectionId: string | null;
  // The product's primary image (Medusa's thumbnail), shared by its variant rows.
  imageUrl?: string;
  // The product's Medusa product type value ('' without one), shared by its variant rows.
  type: string;
  // The variant's option values, "Size: M, Color: Blue" in the product's option order ('' without any).
  attributes: string;
};

/** The product type's value: the document's own `type.value`, else the `type_id` looked up in `types`, else ''. */
export function productTypeValue(doc: unknown, types?: ReadonlyMap<string, string>): string {
  const { type, type_id: id } = (doc ?? {}) as { type?: { value?: unknown } | null; type_id?: unknown };
  const value = type?.value;
  if (typeof value === 'string' && value !== '') return value;
  return (typeof id === 'string' && types?.get(id)) || '';
}

/** The products' non-empty `type_id`s, once each, sorted. */
export function productTypeIds(products: readonly unknown[]): string[] {
  const ids = new Set<string>();
  for (const product of products) {
    const id = (product as { type_id?: unknown } | null)?.type_id;
    if (typeof id === 'string' && id !== '') ids.add(id);
  }
  return [...ids].sort();
}

type ProductOption = { id: string; title: string; values: { id?: unknown; value: string }[] };
// The cached Medusa product's `options` ({ id, title, values: [{ id, value }] }), malformed entries dropped.
function productOptions(doc: unknown): ProductOption[] {
  const options = (doc as { options?: unknown } | null)?.options;
  if (!Array.isArray(options)) return [];
  return options.filter((option) => typeof option?.id === 'string' && typeof option.title === 'string').map((option) => ({
    id: option.id, title: option.title,
    values: Array.isArray(option.values) ? option.values.filter((value: { value?: unknown } | null) => typeof value?.value === 'string') : [],
  }));
}

/** One "<title>: <value>, <value>" line per option of the document that has values, in the document's order. */
export function productOptionLines(doc: unknown): string[] {
  return productOptions(doc).filter((option) => option.values.length)
    .map((option) => `${option.title}: ${option.values.map(({ value }) => value).join(', ')}`);
}

/** The variant's option values as "<title>: <value>" joined by ", " in the product's option order; a value resolves to
 * its option by `option_id`, else by its own id among the option's values, and is skipped when neither matches. */
export function variantAttributes(doc: unknown, variantId: string): string {
  const variants = (doc as { variants?: unknown } | null)?.variants;
  const values = Array.isArray(variants) ? variants.find((variant) => variant?.id === variantId)?.options : undefined;
  if (!Array.isArray(values)) return '';
  const options = productOptions(doc);
  const chosen = new Map<string, string>();
  for (const value of values) {
    if (typeof value?.value !== 'string' || value.value === '') continue;
    const option = options.find(({ id }) => id === value.option_id)
      ?? (typeof value.id === 'string' ? options.find((candidate) => candidate.values.some(({ id }) => id === value.id)) : undefined);
    if (option && !chosen.has(option.id)) chosen.set(option.id, value.value);
  }
  return options.filter(({ id }) => chosen.has(id)).map(({ id, title }) => `${title}: ${chosen.get(id)}`).join(', ');
}

export type ProductTag = { id: string; value: string };

/** The Medusa product's `tags` ({ id, value }), read from the document: TallyUI's product traits have no tag accessor. */
export function productTags(doc: unknown): ProductTag[] {
  const tags = (doc as { tags?: unknown } | null)?.tags;
  if (!Array.isArray(tags)) return [];
  return tags.filter((tag): tag is ProductTag => typeof tag?.id === 'string' && tag.id !== ''
    && typeof tag.value === 'string' && tag.value !== '').map(({ id, value }) => ({ id, value }));
}

const byValue = (a: ProductTag, b: ProductTag) =>
  a.value.localeCompare(b.value, undefined, { numeric: true, sensitivity: 'base' }) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Every tag across the products, once per id (the first value seen), by value in natural order, then by id. */
export function listProductTags(products: readonly unknown[]): ProductTag[] {
  const byId = new Map<string, ProductTag>();
  for (const product of products) for (const tag of productTags(product)) if (!byId.has(tag.id)) byId.set(tag.id, tag);
  return [...byId.values()].sort(byValue);
}

/** The Medusa product's `collection_id`, or null when it is missing, empty or not a string. */
function productCollectionId(doc: unknown): string | null {
  const id = (doc as { collection_id?: unknown } | null)?.collection_id;
  return typeof id === 'string' && id !== '' ? id : null;
}

/** The products' non-empty `collection_id`s, once each, sorted. */
export function productCollectionIds(products: readonly unknown[]): string[] {
  return [...new Set(products.map(productCollectionId).filter((id): id is string => id !== null))].sort();
}

/** The products' collections that have a title in `titles` (id → title), as `{ id, value: title }`, sorted as the tags. */
export function listProductCollections(products: readonly unknown[], titles: ReadonlyMap<string, string>): ProductTag[] {
  return productCollectionIds(products).flatMap((id) => {
    const value = titles.get(id);
    return value ? [{ id, value }] : [];
  }).sort(byValue);
}

export const PRODUCTS_ADMIN_NOTE = 'Products are read-only here. Edit names, prices and stock in Medusa Admin.';
export const PRODUCTS_LOADING = 'Loading the catalogue…';
// Shown when the catalogue read failed without a message of its own.
export const PRODUCTS_LOAD_FAILED = 'The catalogue could not load.';
export const PRODUCTS_EMPTY = 'No products in the catalogue yet.';
export const PRODUCTS_NO_MATCH =(query: string) => `No products match “${query}”.`;
export const PRODUCTS_IN_STOCK_LABEL = 'In stock';
export const PRODUCTS_NONE_IN_STOCK = 'No products are in stock.';
export const PRODUCTS_ON_SALE_LABEL = 'On sale';
export const PRODUCTS_NONE_ON_SALE = 'No products are on sale.';
export const PRODUCTS_NONE_ON_SALE_IN_STOCK = 'No products on sale are in stock.';
export const PRODUCTS_TAGS_LABEL = 'Tags';
export const PRODUCTS_TAGS_SEARCH = 'Search Tags';
export const PRODUCTS_TAGS_NONE = 'No tags match.';
export const PRODUCTS_NONE_TAGGED = (tag: string) => `No products tagged “${tag}” match.`;
export const PRODUCTS_COLLECTIONS_LABEL = 'Collections';
export const PRODUCTS_COLLECTIONS_SEARCH = 'Search Collections';
export const PRODUCTS_COLLECTIONS_NONE = 'No collections match.';
export const PRODUCTS_NONE_IN_COLLECTION = (title: string) => `No products in “${title}” match.`;
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
export function productAreaStockLine(row: Pick<ProductAreaRow, 'stock' | 'stockStatus'>): string {
  const label = STOCK_STATUS_LABELS[row.stockStatus];
  return row.stock === label ? label : `${row.stock} · ${label}`;
}

/** One row per sellable variant, as the Sale's catalogue lists them; `types` maps a product type id to its value. */
export function productAreaRows(products: readonly unknown[], traits: ProductTraits, currency: string,
  types?: ReadonlyMap<string, string>): ProductAreaRow[] {
  return catalogueEntries([...products], traits).map(({ product, variant }) => {
    const name = traits.getName(product);
    const categories = productCategories(product, traits);
    const resolved = resolvePrice(variant.prices, currency);
    const label = (money?: Money) => (money ? formatMoney(money) : undefined) ?? '—';
    return {
      id: variant.id,
      name: traits.getVariantCount(product) > 1 && variant.title ? `${name} · ${variant.title}` : name,
      sku: variant.sku ?? '',
      barcode: variant.barcode ?? '',
      price: label(resolved?.current),
      regularPrice: label(resolved?.was ?? resolved?.current),
      salePrice: resolved?.was ? label(resolved.current) : '',
      onSale: Boolean(resolved?.was),
      stock: typeof variant.stock.quantity === 'number' ? variant.stock.quantity.toLocaleString() : STOCK_STATUS_LABELS[variant.stock.status],
      stockStatus: variant.stock.status,
      categories: categories.map((category) => category.name).join(', '),
      categoryIds: categories.map((category) => category.id),
      tagIds: productTags(product).map((tag) => tag.id),
      collectionId: productCollectionId(product),
      imageUrl: traits.getImageUrl(product),
      type: productTypeValue(product, types),
      attributes: variantAttributes(product, variant.id),
    };
  });
}

// v2's Expanded rows: a product with several sellable variants has a row of its own, its variants open as rows under it.
export type ProductAreaProduct = Omit<ProductAreaRow, 'sku' | 'barcode' | 'salePrice' | 'onSale' | 'attributes'> & {
  sku: ''; barcode: ''; salePrice: ''; onSale: false; attributes: '';
  // One "<group>: <value>, <value>" line per option group, as v2's "Size: XS, S, M".
  options: string[];
  // Its variant rows' ids in catalogue order, with the variant's title (its id when it has none).
  variants: { id: string; title: string }[];
};

// "€20.00 – €25.00" (an en dash), one price when the ends meet, or a dash when no variant resolves.
const rangeLabel = (range?: { min: Money; max: Money }) => {
  if (!range) return '—';
  const min = formatMoney(range.min) ?? '—';
  return range.min.amount === range.max.amount ? min : `${min} – ${formatMoney(range.max) ?? '—'}`;
};
const STATUS_ORDER: StockLevel['status'][] = ['in_stock', 'backorder', 'out_of_stock'];

/** One entry per product with more than one sellable variant; a single-variant product stays a plain variant row. */
export function productAreaProducts(products: readonly unknown[], traits: ProductTraits, currency: string,
  types?: ReadonlyMap<string, string>): ProductAreaProduct[] {
  const byProduct = new Map<unknown, ReturnType<typeof catalogueEntries>>();
  for (const entry of catalogueEntries([...products], traits)) {
    byProduct.set(entry.product, [...byProduct.get(entry.product) ?? [], entry]);
  }
  return [...byProduct].filter(([, entries]) => entries.length > 1).map(([product, entries]) => {
    const variants = entries.map(({ variant }) => variant);
    const categories = productCategories(product, traits);
    const stockStatus = STATUS_ORDER.find((status) => variants.some((variant) => variant.stock.status === status)) ?? 'unknown';
    const quantities = variants.map((variant) => variant.stock.quantity);
    // TallyUI's getVariantOptions when it gives groups; else the cached document's own options.
    const groups = traits.getVariantOptions?.(product) ?? [];
    const regular = variants.map((variant) => resolvePrice(variant.prices, currency)).flatMap((resolved) =>
      resolved ? [{ prices: [{ ...(resolved.was ?? resolved.current), kind: 'base' as const }] }] : []);
    return {
      id: traits.getId ? traits.getId(product) : (product as { id: string }).id,
      name: traits.getName(product),
      options: groups.length ? groups.map((group) => `${group.name}: ${group.values.join(', ')}`) : productOptionLines(product),
      variants: variants.map((variant) => ({ id: variant.id, title: variant.title || variant.id })),
      sku: '', barcode: '', salePrice: '', onSale: false, attributes: '', type: productTypeValue(product, types),
      price: rangeLabel(resolvePriceRange(variants, currency)),
      regularPrice: rangeLabel(resolvePriceRange(regular, currency)),
      stock: quantities.every((quantity) => typeof quantity === 'number')
        ? quantities.reduce((sum: number, quantity) => sum + quantity!, 0).toLocaleString() : STOCK_STATUS_LABELS[stockStatus],
      stockStatus,
      categories: categories.map((category) => category.name).join(', '),
      categoryIds: categories.map((category) => category.id),
      tagIds: productTags(product).map((tag) => tag.id),
      collectionId: productCollectionId(product),
      imageUrl: traits.getImageUrl(product),
    };
  });
}

/** What the table and the phone list render: a product row (`shown` = its variant rows left after the filters), or a
 * variant row, `sub` under its product row, `label` being what its Product cell shows. */
export type ProductAreaItem = ({ kind: 'product' } & ProductAreaProduct & { shown: number; open: boolean })
  | ({ kind: 'variant'; sub: boolean; label: string } & ProductAreaRow);

/** The filtered variant rows as v2's Expanded rows: a product row stands in for its variants, which follow it as sub-rows
 * (only those shown) while it is open. Top-level items, and each product's sub-rows among themselves, follow `sort`. */
export function productAreaItems(shown: ProductAreaRow[], products: ProductAreaProduct[], sort: ProductSort | null,
  isOpen: (productId: string) => boolean, valueOf: (item: ProductAreaItem, field: string) => ProductSortValue): ProductAreaItem[] {
  const owners = new Map(products.flatMap((product) => product.variants.map((variant) => [variant.id, product] as const)));
  // Each product's shown variant rows, by product id; the product takes its first shown variant's place.
  const subRows = new Map<string, ProductAreaRow[]>();
  const top: (ProductAreaRow | ProductAreaProduct)[] = [];
  for (const row of shown) {
    const product = owners.get(row.id);
    if (!product) { top.push(row); continue; }
    if (!subRows.has(product.id)) { subRows.set(product.id, []); top.push(product); }
    subRows.get(product.id)!.push(row);
  }
  const items = top.map((entry): ProductAreaItem => 'variants' in entry
    ? { ...entry, kind: 'product', shown: subRows.get(entry.id)!.length, open: isOpen(entry.id) }
    : { ...entry, kind: 'variant', sub: false, label: entry.name });
  return sortProducts(items, sort, valueOf).flatMap((item) => {
    if (item.kind !== 'product' || !item.open) return [item];
    const subs = subRows.get(item.id)!.map((row): ProductAreaItem => ({ ...row, kind: 'variant', sub: true,
      label: item.variants.find(({ id }) => id === row.id)!.title }));
    return [item, ...sortProducts(subs, sort, valueOf)];
  });
}

/** v2's Open in place: the product's variant rows left in `shown`, as plain rows labelled by the variant title, by `sort`. */
export function productAreaPlaceItems(shown: ProductAreaRow[], product: ProductAreaProduct, sort: ProductSort | null,
  valueOf: (item: ProductAreaItem, field: string) => ProductSortValue): ProductAreaItem[] {
  const titles = new Map(product.variants.map(({ id, title }) => [id, title]));
  const items = shown.filter((row) => titles.has(row.id))
    .map((row): ProductAreaItem => ({ ...row, kind: 'variant', sub: false, label: titles.get(row.id)! }));
  return sortProducts(items, sort, valueOf);
}

/** The product row's toggle: "2 variations", or "1 of 2 variations" while the filters leave fewer. */
export const PRODUCTS_VARIATIONS = (shown: number, total: number) =>
  `${shown === total ? '' : `${shown} of `}${total} ${total === 1 ? 'variation' : 'variations'}`;

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

/** Rows of products in the collection; no collection (null or '') keeps them all. */
export function filterProductAreaRowsByCollection(rows: ProductAreaRow[], collectionId: string | null): ProductAreaRow[] {
  if (!collectionId) return rows;
  return rows.filter((row) => row.collectionId === collectionId);
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

/** Only rows on a Medusa sale price list (`onSale`) when `onSaleOnly`; off returns the same array. */
export function filterProductAreaRowsOnSale(rows: ProductAreaRow[], onSaleOnly: boolean): ProductAreaRow[] {
  if (!onSaleOnly) return rows;
  return rows.filter((row) => row.onSale);
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
