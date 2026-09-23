import { resolvePrice, type ProductTraits } from '@tallyui/core';
import type { OrderBuilder } from '@tallyui/pos';
import type { CatalogueEntry } from './catalogue';

export class CartError extends Error {}

export function addEntryToCart<Doc>(builder: OrderBuilder, entry: CatalogueEntry<Doc>,
  traits: ProductTraits<Doc>, currency: string): string {
  const { product, variant } = entry;
  const existing = builder.getSnapshot().lineItems.find((line) => line.variantId === variant.id);
  if (existing) {
    builder.updateQuantity(existing.id, existing.quantity + 1);
    return existing.id;
  }
  const name = traits.getName(product) + (traits.getVariantCount(product) > 1 ? ` · ${variant.title}` : '');
  const unitPrice = resolvePrice(variant.prices, currency)?.current;
  if (!unitPrice) throw new CartError(`No ${currency} price for ${name}`);
  return builder.addLine({
    productId: traits.getId(product), variantId: variant.id, name,
    sku: variant.sku ?? '', imageUrl: traits.getImageUrl?.(product), unitPrice,
  });
}
