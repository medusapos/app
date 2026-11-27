import { createOrderBuilder, finalizeOrder } from '@tallyui/pos';
import { expect, it } from 'vitest';
import { customerSafeSale, displayConfigFor, displayKeyStore, hasDisplayDeviceKey } from './customer-display';

it('D-1: device keys are stored and cleared per store', async () => {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: data.set.bind(data), removeItem: data.delete.bind(data) };
  const first = displayKeyStore(storage, 'https://a.test');
  const second = displayKeyStore(storage, 'https://b.test');
  await first.save('device-secret');
  expect(await first.load()).toBe('device-secret');
  expect(hasDisplayDeviceKey(storage, 'https://a.test')).toBe(true);
  expect(await second.load()).toBeNull();
  expect(hasDisplayDeviceKey(storage, 'https://b.test')).toBe(false);
  await first.clear();
  expect(await first.load()).toBeNull();
  expect(hasDisplayDeviceKey(storage, 'https://a.test')).toBe(false);
});

it('D-2: storage errors resolve as a missing key or a no-op', async () => {
  const fail = () => { throw Error('storage unavailable'); };
  const storage = { getItem: fail, setItem: fail, removeItem: fail };
  const keys = displayKeyStore(storage, 'https://store.test');
  await expect(keys.load()).resolves.toBeNull();
  await expect(keys.save('key')).resolves.toBeUndefined();
  await expect(keys.clear()).resolves.toBeUndefined();
  expect(hasDisplayDeviceKey(storage, 'https://store.test')).toBe(false);
});

it('D-3: strips only private fields on both orders, without mutating either', () => {
  const builder = createOrderBuilder({ currency: 'EUR', taxContext: { pricesIncludeTax: false, getTaxRatePpm: () => 0 } });
  builder.addLine({ productId: 'shirt', variantId: 'blue', name: 'Shirt', unitPrice: { amount: 1200, currency: 'EUR' } });
  builder.addPayment({ method: 'cash', amountMinor: 1200, reference: 'payment-1' });
  const order = { ...builder.getSnapshot(), customer: { id: '1', name: 'Ada', email: 'ada@example.test' }, note: 'staff only' };
  const receipt = { ...order, id: 'receipt', note: 'private receipt', payments: [{ ...order.payments[0], reference: 'payment-2' }] };
  const stage = { kind: 'receipt' as const, order: receipt, posOrder: finalizeOrder(builder.getSnapshot()) };
  const original = structuredClone({ order, stage });
  const { reference, ...payment } = order.payments[0];
  expect(reference).toBe('payment-1');
  const safe = { customer: null, note: '', payments: [payment] };
  expect(customerSafeSale({ order, stage })).toStrictEqual({ order: { ...order, ...safe }, stage: { ...stage, order: { ...receipt, ...safe } } });
  expect({ order, stage }).toStrictEqual(original);
});

it('D-4: config contains only display identity, store formatting and the app idle delay', () => {
  const display = { displayId: 'screen-1', name: 'Counter' };
  const settings = { storeName: 'Main shop', currency: 'EUR', location: { id: 'loc', name: 'Main', countryCode: 'dk' } };
  const config = { contract: '1.0', display: { id: 'screen-1', name: 'Counter' }, presentation_hints: {}, i18n: {}, idle: { afterCompleteMs: 10000 } };
  expect(displayConfigFor(display, settings, 'da')).toEqual({ ...config, store: { id: 'loc', name: 'Main shop', currency: 'EUR', locale: 'da' } });
  expect(displayConfigFor(display, null, 'en')).toEqual({ ...config, store: { id: '', name: '', currency: '', locale: 'en' } });
});
