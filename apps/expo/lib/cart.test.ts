import { describe, expect, it } from 'vitest';
import { medusaConnector } from '@tallyui/connector-medusa';
import { createOrderBuilder } from '@tallyui/pos';
import { catalogueEntries } from './catalogue';
import { addEntryToCart, CartError } from './cart';
import { taxContextFor } from './store-settings';

const traits = medusaConnector.traits.product;
const product = {
  id: 'shirt', title: 'Shirt', thumbnail: 'https://store.test/shirt.jpg',
  variants: [{ id: 'small', title: 'Small', sku: 'SHIRT-S', prices: [{ amount: 10, currency_code: 'eur' }] }],
};
const entry = catalogueEntries([product], traits)[0];
function orderBuilder() {
  return createOrderBuilder({ currency: 'EUR', taxContext: taxContextFor({
    storeName: 'Store', currency: 'EUR', location: { id: 'loc_1', name: 'Warehouse', countryCode: 'de' },
    taxRatePpm: 190000, pricesIncludeTax: false,
  }) });
}

describe('addEntryToCart', () => {
  it('adds the selected variant with the product fields and integer minor-unit price', () => {
    const builder = orderBuilder();
    const id = addEntryToCart(builder, entry, traits, 'EUR');
    expect(builder.getSnapshot().lineItems).toHaveLength(1);
    expect(builder.getSnapshot().lineItems[0]).toMatchObject({
      id, productId: 'shirt', variantId: 'small', name: 'Shirt', sku: 'SHIRT-S',
      imageUrl: product.thumbnail, unitPriceMinor: 1000, quantity: 1,
    });
  });
  it('increments the same line and lets TallyUI compute 2 × EUR 10 at 19% exclusive', () => {
    const builder = orderBuilder();
    const id = addEntryToCart(builder, entry, traits, 'EUR');
    expect(addEntryToCart(builder, entry, traits, 'EUR')).toBe(id);
    const order = builder.getSnapshot();
    expect(order.lineItems).toHaveLength(1);
    expect(order.lineItems[0].quantity).toBe(2);
    expect(order.totalMinor).toBe(2380);
  });
  it('increments by variant id even if the catalogue price changes', () => {
    const builder = orderBuilder();
    const id = addEntryToCart(builder, entry, traits, 'EUR');
    const changed = { ...product, variants: [{ ...product.variants[0], prices: [{ amount: 12, currency_code: 'eur' }] }] };
    expect(addEntryToCart(builder, catalogueEntries([changed], traits)[0], traits, 'EUR')).toBe(id);
    expect(builder.getSnapshot().lineItems).toHaveLength(1);
    expect(builder.getSnapshot().lineItems[0]).toMatchObject({ quantity: 2, unitPriceMinor: 1000 });
  });
  it('uses the selected variant price and title for a multi-variant product', () => {
    const multi = { ...product, variants: [...product.variants,
      { id: 'large', title: 'Large', sku: 'SHIRT-L', prices: [{ amount: 15, currency_code: 'eur' }] },
    ] };
    const builder = orderBuilder();
    const entries = catalogueEntries([multi], traits);
    addEntryToCart(builder, entries[0], traits, 'EUR');
    addEntryToCart(builder, entries[1], traits, 'EUR');
    expect(builder.getSnapshot().lineItems).toMatchObject([
      { variantId: 'small', name: 'Shirt · Small', unitPriceMinor: 1000 },
      { variantId: 'large', name: 'Shirt · Large', unitPriceMinor: 1500 },
    ]);
  });
  it('uses an empty SKU when the selected variant has none', () => {
    const noSku = { ...product, variants: [{ id: 'plain', prices: [{ amount: 10, currency_code: 'eur' }] }] };
    const builder = orderBuilder();
    addEntryToCart(builder, catalogueEntries([noSku], traits)[0], traits, 'EUR');
    expect(builder.getSnapshot().lineItems[0].sku).toBe('');
  });
  it('throws CartError with the currency and product name when there is no EUR price', () => {
    const unpriced = { ...product, variants: [{ ...product.variants[0], prices: [{ amount: 10, currency_code: 'usd' }] }] };
    const builder = orderBuilder();
    const add = () => addEntryToCart(builder, catalogueEntries([unpriced], traits)[0], traits, 'EUR');
    expect(add).toThrow(CartError);
    expect(add).toThrow('No EUR price for Shirt');
    expect(builder.getSnapshot().lineItems).toHaveLength(0);
  });
});
