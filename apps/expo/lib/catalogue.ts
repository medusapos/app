import { findVariantByCode, formatMoney, resolvePrice } from '@tallyui/core';
import type { ProductTraits, VariantSummary } from '@tallyui/core';

export type CatalogueEntry<Doc> = { product: Doc; variant: VariantSummary };

/** Every variant of every product, in product order then variant order. */
export function catalogueEntries<Doc>(products: Doc[], traits: ProductTraits<Doc>): CatalogueEntry<Doc>[] {
  return products.flatMap((product) => traits.getVariants!(product).map((variant) => ({ product, variant })));
}

/** Barcode-then-SKU lookup across all products. */
export function findEntryByCode<Doc>(entries: CatalogueEntry<Doc>[], code: string): CatalogueEntry<Doc> | undefined {
  const variant = findVariantByCode(entries.map((entry) => entry.variant), code);
  return variant ? entries.find((entry) => entry.variant === variant) : undefined;
}

/** Display the resolved price in the requested currency. */
export function variantPriceLabel(variant: VariantSummary, currency: string, locale?: string): string | undefined {
  const price = resolvePrice(variant.prices, currency);
  return price ? formatMoney(price.current, locale) : undefined;
}
