import { describe, expect, it } from 'vitest';
import { DEFAULT_CART_SETTINGS, loadCartSettings, saveCartSettings, type CartSettings } from './cart-settings';

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
      autoShowReceipt: false };
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
    expect(loadCartSettings(storage, 'https://a.test')).toEqual({ ...legacy, columns: DEFAULT_CART_SETTINGS.columns, autoShowReceipt: true });
  });

  it.each([{ total: { show: 'yes' } }, { subtotal: { show: true } }, { image: { split: true } }, { price: true }, []])(
    'keeps the other fields and uses the default columns on invalid stored columns: %j', (columns) => {
      const stored = { cartSide: 'left', openOrders: 'top', quickDiscounts: [20, 30, 40], columns };
      const storage = fakeStorage({ 'medusapos.cart.https://a.test': JSON.stringify(stored) });
      expect(loadCartSettings(storage, 'https://a.test')).toEqual({ ...stored, columns: DEFAULT_CART_SETTINGS.columns, autoShowReceipt: true });
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
    expect(loadCartSettings(storage, 'https://a.test')).toEqual({ ...stored, autoShowReceipt: true });
  });

  it('refuses to save a non-boolean autoShowReceipt', () => {
    expect(() => saveCartSettings(fakeStorage(), 'https://a.test', { ...DEFAULT_CART_SETTINGS, autoShowReceipt: 'no' as never }))
      .toThrow('Auto show receipt must be on or off.');
  });
});
