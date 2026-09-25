import { describe, expect, it } from 'vitest';
import { medusaConnector } from '@tallyui/connector-medusa';
import { catalogueEntries, findEntryByCode, variantPriceLabel } from '@tallyui/pos';
import { classifyReplicationError } from './use-replicated-products';

const traits = medusaConnector.traits.product;
const products = [
  { id: 'shirt', title: 'Shirt', status: 'published', variants: [
    { id: 'small', title: 'Small', sku: 'COLLISION', barcode: '111',
      prices: [{ amount: 20, currency_code: 'eur' }],
      calculated_price: { currency_code: 'eur', calculated_amount: 12.5, original_amount: 20,
        calculated_price: { price_list_type: 'sale' } } },
    { id: 'large', title: 'Large', sku: ' LARGE ', barcode: '222', prices: [] },
  ] },
  { id: 'hat', title: 'Hat', status: 'published', variants: [
    { id: 'hat-one', title: 'One size', sku: 'HAT', barcode: ' collision ', prices: [] },
  ] },
];

describe('catalogue helpers', () => {
  const entries = catalogueEntries(products, traits);
  it('enumerates products and their variants in order through traits', () => {
    expect(entries).toEqual(products.flatMap((product) =>
      traits.getVariants!(product).map((variant) => ({ product, variant }))));
    expect(entries.map(({ variant }) => variant.id)).toEqual(['small', 'large', 'hat-one']);
    expect(catalogueEntries([], traits)).toEqual([]);
  });
  it('prefers a barcode over a SKU in another product', () => {
    expect(findEntryByCode(entries, 'COLLISION')).toBe(entries[2]);
  });
  it('ignores case and surrounding whitespace for barcode and SKU', () => {
    expect(findEntryByCode(entries, '  CoLlIsIoN  ')).toBe(entries[2]);
    expect(findEntryByCode(entries, ' large ')).toBe(entries[1]);
  });
  it.each(['', '   ', 'missing'])('returns undefined for %j', (code) => {
    expect(findEntryByCode(entries, code)).toBeUndefined();
  });
  it('formats the resolved EUR sale price in minor units', () => {
    expect(variantPriceLabel(entries[0].variant, 'EUR', 'en-IE')).toBe('€12.50');
  });
  it('omits a price when the requested currency is absent', () => {
    expect(variantPriceLabel(entries[0].variant, 'USD', 'en-US')).toBeUndefined();
    expect(variantPriceLabel(entries[1].variant, 'EUR', 'en-IE')).toBeUndefined();
  });
});

describe('classifyReplicationError', () => {
  it.each([
    [new Error('Medusa API error: 401'), 'unauthorized'],
    [new Error('Medusa API error: 403'), 'http'],
    [new Error('Medusa API error: 500'), 'http'],
    [new TypeError('Failed to fetch'), 'offline'],
    [new Error('connection lost'), 'offline'],
  ] as const)('classifies direct and RxDB-wrapped errors: %j', (error, expected) => {
    expect(classifyReplicationError(error)).toBe(expected);
    expect(classifyReplicationError({
      message: 'RxDB replication error', parameters: { errors: [error] },
    })).toBe(expected);
  });
  it.each([null, undefined, {}, { parameters: { errors: [] } }])('handles %j as offline', (error) => {
    expect(classifyReplicationError(error)).toBe('offline');
  });
});
