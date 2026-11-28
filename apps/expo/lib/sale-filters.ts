import { resolvePrice, type ProductTraits } from '@tallyui/core';
import { catalogueEntries, inCategory, listCategories, productSortValue, searchProducts, sortProducts, type ProductSort } from '@tallyui/pos';
import { productCollectionId, productTags } from './products-area';
import type { SessionStorage } from './session';

/** The Sale's stored pills beside In Stock (kept under its own key): Medusa sale price lists, a product tag
 * id and a product collection id. */
export type SaleFilters = { onSale: boolean; tag: string | null; collection: string | null };
export const NO_SALE_FILTERS: SaleFilters = { onSale: false, tag: null, collection: null };

// One key per store on this device, apart from the Products area's chips.
const PREFIX = 'medusapos.sale-filters.';
const id = (value: unknown) => (typeof value === 'string' && value !== '' ? value : null);

/** Each field read on its own: a missing, corrupt or wrongly typed one is its default. Never throws. */
export function loadSaleFilters(storage: SessionStorage | null, baseUrl: string): SaleFilters {
  let value: unknown = null;
  try { value = JSON.parse(storage?.getItem(PREFIX + baseUrl) ?? 'null'); } catch { /* corrupt: the defaults */ }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return NO_SALE_FILTERS;
  const { onSale, tag, collection } = value as Record<string, unknown>;
  return { onSale: onSale === true, tag: id(tag), collection: id(collection) };
}

export function saveSaleFilters(storage: SessionStorage | null, baseUrl: string, filters: SaleFilters): void {
  try {
    storage?.setItem(PREFIX + baseUrl, JSON.stringify(filters));
  } catch (error) { console.warn('Could not save the Sale filters:', error); }
}

export function loadSaleInStock(storage: SessionStorage | null, baseUrl: string): boolean {
  try { return JSON.parse(storage?.getItem(`medusapos.sale-in-stock.${baseUrl}`) ?? 'false') === true; }
  catch { return false; }
}

export function saveSaleInStock(storage: SessionStorage | null, baseUrl: string, on: boolean): void {
  try { storage?.setItem(`medusapos.sale-in-stock.${baseUrl}`, JSON.stringify(on)); }
  catch (error) { console.warn('Could not save the Sale In Stock filter:', error); }
}

/** Some variant's price in `currency` comes from a Medusa sale price list (it has a `was`). */
export function isOnSale<Doc>(product: Doc, traits: ProductTraits<Doc>, currency: string): boolean {
  return catalogueEntries([product], traits, { currency }).some(({ variant }) => Boolean(resolvePrice(variant.prices, currency)?.was));
}

export type SaleFilterOptions<Doc> = {
  traits: ProductTraits<Doc>; currency: string;
  /** The applied picks only: a stored pick with no pill to show it is passed as off. */
  picks: SaleFilters;
  /** The viewState's category, applied only while some product is still in it. */
  categoryId?: string | null;
  query: string; inStock: boolean; sort?: ProductSort | null;
};

/** What Catalogue would list, in its own order and by its own rules (category, search, In Stock), narrowed by the picks,
 * then sorted. Returns a new array; the input is untouched. */
export function saleFilterItems<Doc>(products: readonly Doc[], { traits, currency, picks, categoryId, query, inStock, sort }: SaleFilterOptions<Doc>): Doc[] {
  const listed = categoryId && listCategories(products, traits).some((category) => category.id === categoryId);
  const matched = searchProducts(listed ? products.filter((doc) => inCategory(doc, categoryId, traits)) : [...products], query, traits);
  const picked = matched.filter((doc) => (!inStock || !['out_of_stock', 'backorder'].includes(traits.getStock(doc).status))
    && (!picks.onSale || isOnSale(doc, traits, currency))
    && (picks.tag === null || productTags(doc).some((tag) => tag.id === picks.tag))
    && (picks.collection === null || productCollectionId(doc) === picks.collection));
  return sortProducts(picked, sort, (doc, field) => productSortValue(doc, field, traits, { currency }));
}
