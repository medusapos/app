import { describe, expect, it } from 'vitest';
import type { StoreOrder, StoreOrderLine } from '@tallyui/core';
import { buildReopenCart, requestReopen, takeReopen } from './reopen-order';

const line = (name: string, quantity: number, variantId?: string): StoreOrderLine =>
  ({ id: `line_${name}`, name, quantity, variantId, subtotalMinor: 0, subtotalTaxMinor: 0, totalMinor: 0, taxMinor: 0 });
const order = (lines: StoreOrderLine[], customer: StoreOrder['customer'] = null): StoreOrder => ({
  id: 'order_1', reference: '1001', status: 'completed', placedAt: '2026-11-24T09:00:00.000Z', currency: 'EUR',
  pricesIncludeTax: false, customer, lines, fees: [], shipping: [], coupons: [], taxLines: [], discountMinor: 0,
  discountTaxMinor: 0, taxMinor: 0, totalMinor: 0, payments: [], refunds: [],
});
// The catalogue's entries by variant id; the reopen takes them as they are, prices and all.
const catalogue = new Map([['blue', { variant: { id: 'blue' } }], ['red', { variant: { id: 'red' } }]]);
const lookup = (variantId: string) => catalogue.get(variantId);

it('drops a reopen taken by another store and returns a matching request only once', () => {
  const placed = order([line('Red hat', 1, 'red')]);
  requestReopen(placed, 'https://a.test');
  expect(takeReopen('https://b.test')).toBeNull();
  expect(takeReopen('https://a.test')).toBeNull();
  requestReopen(placed, 'https://a.test');
  expect(takeReopen('https://a.test')).toBe(placed);
  expect(takeReopen('https://a.test')).toBeNull();
});

describe('buildReopenCart', () => {
  it("builds the order's lines with their quantities and its customer, from the catalogue", () => {
    const placed = order([line('Red hat', 3, 'red'), line('Blue shirt', 1, 'blue')],
      { id: 'ada', name: 'Ada Lovelace', email: 'ada@example.test' });
    expect(buildReopenCart(placed, lookup)).toEqual({
      lines: [{ entry: catalogue.get('red'), quantity: 3 }, { entry: catalogue.get('blue'), quantity: 1 }],
      customer: { id: 'ada', name: 'Ada Lovelace', email: 'ada@example.test' },
    });
  });

  it('refuses an order whose variant is no longer in the catalogue, naming the line', () => {
    const placed = order([line('Blue shirt', 1, 'blue'), line('Old scarf', 2, 'gone'), line('Older cap', 1, 'gone2')]);
    expect(buildReopenCart(placed, lookup)).toBe('Can\'t reopen: "Old scarf" is no longer for sale.');
  });

  it('refuses a custom line without a variant', () => {
    expect(buildReopenCart(order([line('Blue shirt', 1, 'blue'), line('Gift wrap', 1)]), lookup))
      .toBe('Can\'t reopen: "Gift wrap" is no longer for sale.');
  });

  it('a guest order builds no customer', () => {
    expect(buildReopenCart(order([line('Blue shirt', 2, 'blue')]), lookup))
      .toEqual({ lines: [{ entry: catalogue.get('blue'), quantity: 2 }], customer: null });
  });
});
