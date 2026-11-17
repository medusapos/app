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
    const settings: CartSettings = { cartSide: 'left', openOrders: 'top', quickDiscounts: [20, 30, 40] };
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
});
