import { describe, expect, it } from 'vitest';
import { DEFAULT_CART_SETTINGS, loadCartSettings, saveCartSettings, sortCartLines, type CartSettings } from './cart-settings';

function fakeStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  };
}

describe('cart-settings', () => {
  it('round-trips a saved value', () => {
    const storage = fakeStorage();
    const settings: CartSettings = { cartSide: 'left', openOrders: 'top', quickDiscounts: [20, 30, 40], columns: DEFAULT_CART_SETTINGS.columns,
      autoShowReceipt: false, sortItems: 'name' };
    saveCartSettings(storage, 'https://a.test', settings);
    expect(loadCartSettings(storage, 'https://a.test')).toEqual(settings);
  });

  it('uses the defaults when nothing is stored', () => {
    expect(loadCartSettings(fakeStorage(), 'https://a.test')).toEqual(DEFAULT_CART_SETTINGS);
  });

  it('uses the defaults on corrupt JSON', () => {
    const storage = fakeStorage({ 'medusapos.cart.https://a.test': 'not json' });
    expect(loadCartSettings(storage, 'https://a.test')).toEqual(DEFAULT_CART_SETTINGS);
  });

  it.each([{ quickDiscounts: [5, 10] }, { quickDiscounts: [0, 10, 15] }, { cartSide: 'up' }, { openOrders: 'middle' }])(
    'uses the defaults on an invalid stored value: %j', (invalid) => {
      const storage = fakeStorage({ 'medusapos.cart.https://a.test': JSON.stringify({ ...DEFAULT_CART_SETTINGS, ...invalid }) });
      expect(loadCartSettings(storage, 'https://a.test')).toEqual(DEFAULT_CART_SETTINGS);
    },
  );

  it.each([101, 2.5])('refuses to save an invalid quick discount: %s', (value) => {
    expect(() => saveCartSettings(fakeStorage(), 'https://a.test', { ...DEFAULT_CART_SETTINGS, quickDiscounts: [5, 10, value] }))
      .toThrow('Quick discounts must be three whole numbers from 1 to 100.');
  });

  it('gives settings saved before the Columns section the default columns and keeps the rest', () => {
    const legacy = { cartSide: 'left', openOrders: 'top', quickDiscounts: [20, 30, 40] };
    const storage = fakeStorage({ 'medusapos.cart.https://a.test': JSON.stringify(legacy) });
    expect(loadCartSettings(storage, 'https://a.test')).toEqual({ ...legacy, columns: DEFAULT_CART_SETTINGS.columns, autoShowReceipt: true,
      sortItems: 'newest-bottom' });
  });

  it.each([{ total: { show: 'yes' } }, { subtotal: { show: true } }, { image: { split: true } }, { price: true }, []])(
    'keeps the other fields and uses the default columns on invalid stored columns: %j', (columns) => {
      const stored = { cartSide: 'left', openOrders: 'top', quickDiscounts: [20, 30, 40], columns };
      const storage = fakeStorage({ 'medusapos.cart.https://a.test': JSON.stringify(stored) });
      expect(loadCartSettings(storage, 'https://a.test')).toEqual({ ...stored, columns: DEFAULT_CART_SETTINGS.columns, autoShowReceipt: true,
        sortItems: 'newest-bottom' });
    },
  );

  it('round-trips non-default columns, leaving missing flags missing', () => {
    const storage = fakeStorage();
    const settings: CartSettings = { ...DEFAULT_CART_SETTINGS,
      columns: { quantity: { show: true, split: true }, sku: { show: true }, total: { show: false } } };
    saveCartSettings(storage, 'https://a.test', settings);
    expect(loadCartSettings(storage, 'https://a.test')).toEqual(settings);
  });

  it('refuses to save invalid columns', () => {
    const columns = { total: { show: 'yes' } } as unknown as CartSettings['columns'];
    expect(() => saveCartSettings(fakeStorage(), 'https://a.test', { ...DEFAULT_CART_SETTINGS, columns }))
      .toThrow('Cart columns are not valid.');
  });

  it('shows the receipt after checkout by default, as v2 does', () => {
    expect(DEFAULT_CART_SETTINGS.autoShowReceipt).toBe(true);
  });

  it.each([{}, { autoShowReceipt: 'no' }])('loads a missing or invalid autoShowReceipt as on, keeping the rest: %j', (extra) => {
    const stored = { cartSide: 'left', openOrders: 'top', quickDiscounts: [20, 30, 40], columns: { sku: { show: true } }, ...extra };
    const storage = fakeStorage({ 'medusapos.cart.https://a.test': JSON.stringify(stored) });
    expect(loadCartSettings(storage, 'https://a.test')).toEqual({ ...stored, autoShowReceipt: true, sortItems: 'newest-bottom' });
  });

  it('refuses to save a non-boolean autoShowReceipt', () => {
    expect(() => saveCartSettings(fakeStorage(), 'https://a.test', { ...DEFAULT_CART_SETTINGS, autoShowReceipt: 'no' as never }))
      .toThrow('Auto show receipt must be on or off.');
  });

  it('keeps the cart in the order added by default', () => {
    expect(DEFAULT_CART_SETTINGS.sortItems).toBe('newest-bottom');
  });

  it.each([{}, { sortItems: 'size' }])('loads a missing or invalid sortItems as newest at bottom, keeping the rest: %j', (extra) => {
    const stored = { cartSide: 'left', openOrders: 'top', quickDiscounts: [20, 30, 40], columns: { sku: { show: true } },
      autoShowReceipt: false, ...extra };
    const storage = fakeStorage({ 'medusapos.cart.https://a.test': JSON.stringify(stored) });
    expect(loadCartSettings(storage, 'https://a.test')).toEqual({ ...stored, sortItems: 'newest-bottom' });
  });

  it('refuses to save an unknown sortItems', () => {
    expect(() => saveCartSettings(fakeStorage(), 'https://a.test', { ...DEFAULT_CART_SETTINGS, sortItems: 'size' as never }))
      .toThrow('Sort items is not valid.');
  });
});

describe('sortCartLines', () => {
  // Added in this order; zebra and Zebra share a name (case-insensitive) and Apple and apple pie share a price.
  const lines = [{ id: '1', name: 'zebra', unitPriceMinor: 300 }, { id: '2', name: 'Apple', unitPriceMinor: 500 },
    { id: '3', name: 'banana', unitPriceMinor: 100 }, { id: '4', name: 'Zebra', unitPriceMinor: 700 },
    { id: '5', name: 'apple pie', unitPriceMinor: 500 }];
  const ids = (sorted: readonly { id: string }[]) => sorted.map((line) => line.id);
  const original = lines.map((line) => line.id);

  it('hands back the same array for newest at bottom', () => {
    expect(sortCartLines(lines, 'newest-bottom')).toBe(lines);
  });

  it('puts the last line added first for newest at top', () => {
    expect(ids(sortCartLines(lines, 'newest-top'))).toEqual(['5', '4', '3', '2', '1']);
    expect(ids(lines)).toEqual(original);
  });

  it('sorts A to Z by name, case-insensitive, keeping the order added on equal names', () => {
    expect(sortCartLines(lines, 'name').map((line) => line.name)).toEqual(['Apple', 'apple pie', 'banana', 'zebra', 'Zebra']);
    expect(ids(lines)).toEqual(original);
  });

  it('sorts by the price of one, lowest first, keeping the order added on equal prices', () => {
    expect(ids(sortCartLines(lines, 'price'))).toEqual(['3', '1', '2', '5', '4']);
    expect(ids(lines)).toEqual(original);
  });
});
