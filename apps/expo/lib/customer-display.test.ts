import { buildReceiptData, createOrderBuilder, finalizeOrder } from '@tallyui/pos';
import { expect, it } from 'vitest';
import { clearDisplayStore, customerSafeSale, DISPLAY_STORE_KEY, displayConfigFor, displayKeyStore, displayTokenStore,
  hasDisplayDeviceKey, loadDisplayStore, saveDisplayStore } from './customer-display';

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
  builder.addLine({ productId: 'shirt', variantId: 'blue', sku: 'BLUE', name: 'Shirt', unitPrice: { amount: 1200, currency: 'EUR' } });
  builder.addPayment({ method: 'cash', methodId: 'internal-id', amountMinor: 1200, reference: 'payment-1' });
  const order = { ...builder.getSnapshot(), customer: { id: '1', name: 'Ada', email: 'ada@example.test' }, note: 'staff only' };
  const receipt = { ...order, id: 'receipt', note: 'private receipt', payments: [{ ...order.payments[0], reference: 'payment-2' }] };
  const stage = { kind: 'receipt' as const, order: receipt, posOrder: finalizeOrder(builder.getSnapshot()) };
  const original = structuredClone({ order, stage });
  const { reference, methodId, ...payment } = order.payments[0];
  expect(reference).toBe('payment-1');
  expect(methodId).toBe('internal-id');
  const safe = { customer: null, note: '', lineItems: order.lineItems.map((line) => ({ ...line, sku: '' })),
    payments: [{ ...payment, method: 'Cash' }] };
  expect(customerSafeSale({ order, stage })).toStrictEqual({ order: { ...order, ...safe }, stage: { ...stage, order: { ...receipt, ...safe } } });
  expect({ order, stage }).toStrictEqual(original);
  const card = { ...order, payments: [{ ...payment, method: 'external' }] };
  expect(customerSafeSale({ order: card, stage: { kind: 'cart' } }).order.payments[0].method).toBe('Card terminal');
});

it('D-4: config contains only display identity, store formatting and the app idle delay', () => {
  const display = { displayId: 'screen-1', name: 'Counter' };
  const settings = { storeName: 'Main shop', currency: 'EUR', location: { id: 'loc', name: 'Main', countryCode: 'dk' } };
  const config = { contract: '1.0', display: { id: 'screen-1', name: 'Counter' }, presentation_hints: {}, i18n: {}, idle: { afterCompleteMs: 10000 } };
  expect(displayConfigFor(display, settings, 'da')).toEqual({ ...config, store: { id: '', name: 'Main shop', currency: 'EUR', locale: 'da' } });
  expect(displayConfigFor(display, null, 'en')).toEqual({ ...config, store: { id: '', name: '', currency: '', locale: 'en' } });
});

it('F-1: the receipt contains the customer’s own bill and only public metadata', () => {
  const builder = createOrderBuilder({ currency: 'EUR', taxContext: { pricesIncludeTax: false, getTaxRatePpm: () => 0 } });
  const unitPrice = { amount: 1200, currency: 'EUR' };
  const shirt = builder.addLine({ productId: 'shirt', name: 'Shirt', attributes: { Size: 'Large' }, sku: 'SKU-1', unitPrice });
  builder.applyLineDiscount(shirt, { type: 'percentage', value: 10 });
  builder.addLine({ productId: 'custom', custom: true, name: 'Alteration', unitPrice });
  builder.addFee({ name: 'Gift wrap', amountMinor: 50 });
  builder.addShipping({ name: 'Courier', amountMinor: 100 });
  builder.addPayment({ method: 'cash', reference: 'private-reference', amountMinor: 2430 });
  const order = { ...builder.getSnapshot(), note: 'Staff note', customer: { id: '1', name: 'Ada' } };
  const receipt = buildReceiptData(customerSafeSale({ order, stage: { kind: 'cart' } }).order, { storeName: 'Main shop' });
  expect(JSON.stringify(receipt)).not.toMatch(/SKU-1|private-reference/);
  for (const line of receipt.lineItems) expect(['', undefined]).toContain(line.sku);
  expect(receipt.lineItems).toMatchObject([{ name: 'Shirt', attributes: { Size: 'Large' }, quantity: 1, unitPriceMinor: 1200,
    lineTotalMinor: 1080 }, { name: 'Alteration' }]);
  expect(receipt.payments.map(({ method }) => method)).toEqual(['Cash']);
  // The customer's own receipt number is also how useSaleDisplay distinguishes sales.
  expect(receipt.header.orderNumber).toBe(order.id);
  expect(receipt.footer.barcode).toBe(order.id);
  expect(receipt.header.date).toBe(order.createdAt);
  expect(receipt.header.customer).toBeUndefined();
  expect(receipt.header.cashier).toBeUndefined();
  expect(receipt.header.register).toBeUndefined();
  expect(receipt.footer.note).toBeUndefined();
  expect(receipt.software).toEqual({ name: 'WCPOS', plugin_version: '', app_version: '', app_build: '', platform: '' });
  expect(receipt.register).toEqual({ id: '', name: '' });
  expect(receipt.fiscal).toEqual({ document_type: 'sale', is_reprint: false, reprint_count: 0, qr_payload: '' });
  const discounts = [...receipt.discounts, ...receipt.lineItems.flatMap((line) => line.displayDiscounts ?? [])];
  expect(discounts).toHaveLength(1);
  for (const discount of discounts) expect(discount.label).toMatch(/^(percentage|fixed) discount$/);
  expect(receipt.fees).toEqual([{ name: 'Gift wrap', amountMinor: 50 }]);
  expect(receipt.shipping).toEqual([{ name: 'Courier', amountMinor: 100 }]);
});

const fail = () => { throw Error('storage unavailable'); };
const unavailable = { getItem: fail, setItem: fail, removeItem: fail };

it('DS-1: display tokens are separate from other stores and till device keys', async () => {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: data.set.bind(data), removeItem: data.delete.bind(data) };
  const first = displayTokenStore(storage, 'https://a.test');
  const second = displayTokenStore(storage, 'https://b.test');
  await displayKeyStore(storage, 'https://a.test').save('till-secret');
  expect(await first.load()).toBeNull();
  await first.save('first');
  expect(await first.load()).toBe('first');
  expect(await second.load()).toBeNull();
  await second.save('second');
  await first.clear();
  expect(await first.load()).toBeNull();
  expect(await second.load()).toBe('second');
  expect(data.get('medusapos.display-device-key.https://a.test')).toBe('till-secret');
  expect(data.get('medusapos.display.https://b.test')).toBe('second');
  const broken = displayTokenStore(unavailable, 'https://a.test');
  await expect(broken.load()).resolves.toBeNull();
  await expect(broken.save('token')).resolves.toBeUndefined();
  await expect(broken.clear()).resolves.toBeUndefined();
});

it('DS-2: the saved display store round-trips and tolerates unavailable storage', () => {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: data.set.bind(data), removeItem: data.delete.bind(data) };
  saveDisplayStore(storage, 'https://shop.test');
  expect(DISPLAY_STORE_KEY).toBe('medusapos.display-store');
  expect(data.get(DISPLAY_STORE_KEY)).toBe('https://shop.test');
  expect(loadDisplayStore(storage)).toBe('https://shop.test');
  clearDisplayStore(storage);
  expect(loadDisplayStore(storage)).toBeNull();
  expect(loadDisplayStore(unavailable)).toBeNull();
  expect(saveDisplayStore(unavailable, 'https://shop.test')).toBeUndefined();
  expect(clearDisplayStore(unavailable)).toBeUndefined();
});

it.each([
  ['not a url', null],
  ['http://shop.example.com', null],
  ['ftp://x', null],
  ['https://shop.test/', 'https://shop.test'],
  ['http://192.168.1.20:9000', 'http://192.168.1.20:9000'],
] as const)('DS-3: validates and normalizes the saved store %s', (stored, expected) => {
  const storage = { ...unavailable, getItem: (key: string) => key === DISPLAY_STORE_KEY ? stored : null };
  expect(loadDisplayStore(storage)).toBe(expected);
});
