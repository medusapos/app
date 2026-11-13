import { describe, expect, it, vi } from 'vitest';
import { COUPONS_NEED_CONNECTION, couponPricingBasis, createOrderBuilder,
  type Order, type SaleDiscountState, type StorePricedAccepted } from '@tallyui/pos';
import { COUPON_CHECK_FAILED, COUPON_INCLUSIVE_DISCOUNT, COUPON_NEEDS_ITEMS, COUPON_PREVIEW_TIMEOUT_MS,
  couponPreviewRequest, createMedusaDiscountCodes, type MedusaDiscountCodesOptions } from './coupons';

const baseUrl = '  https://store.test///  ';
const builder = (pricesIncludeTax = false) => createOrderBuilder({ currency: 'EUR',
  taxContext: { pricesIncludeTax, getTaxRatePpm: () => 190000 } });
const item = { productId: 'product', variantId: 'variant', name: 'Item', unitPrice: { amount: 1000, currency: 'EUR' } };
function order(pricesIncludeTax = false) {
  const b = builder(pricesIncludeTax);
  b.addLine(item);
  return b.getSnapshot();
}
const state = (order: Order): SaleDiscountState<StorePricedAccepted> => ({ order, accepted: new Map(),
  categories: new Map(), settings: { calcDiscountsSequentially: false } });
const priced = { couponId: 'promo', lines: [{ lineId: 'store-line', amountMinor: 137 }] };
function store(body: unknown = { coupons: [priced] }, status = 200) {
  const calls: Array<{ url: string; init?: RequestInit; body: unknown }> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init, body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(body), { status });
  });
  return { calls, fetchImpl };
}
const provider = (fetchImpl: typeof fetch, options: Partial<MedusaDiscountCodesOptions> = {}) =>
  createMedusaDiscountCodes({ baseUrl, token: () => 'token', fetchImpl, ...options });
const transient = { refusal: COUPONS_NEED_CONNECTION, transient: true };

describe('Medusa discount codes', () => {
  it('maps an exclusive discounted order and reads the token for each POST', async () => {
    const b = builder();
    const first = b.addLine({ ...item, quantity: 2, taxRates: [{ ratePpm: 100000 }, { ratePpm: 90000 }] });
    const second = b.addLine({ ...item, productId: 'fallback', variantId: undefined, quantity: 3 });
    b.applyLineDiscount(first, { type: 'percentage', value: 10 });
    b.setCustomer({ id: 'customer', name: 'Customer' });
    const fake = store();
    let token = 'first-token';
    const codes = provider(fake.fetchImpl, { token: () => token });
    await codes.find('save', state(b.getSnapshot()));
    expect(fake.calls[0].body).toEqual({ currency: 'EUR', customerId: 'customer', codes: ['save'], lines: [
      { lineId: first, variantId: 'variant', quantity: 2, taxInclusive: false, netMinor: 1800, taxRatePpm: 190000 },
      { lineId: second, variantId: 'fallback', quantity: 3, taxInclusive: false, netMinor: 3000, taxRatePpm: 190000 },
    ] });
    expect(fake.calls[0].url).toBe('https://store.test/tally/v1/promotions/preview');
    expect(fake.calls[0].init?.method).toBe('POST');
    expect(new Headers(fake.calls[0].init?.headers).get('Content-Type')).toBe('application/json');
    expect(new Headers(fake.calls[0].init?.headers).get('Authorization')).toBe('Bearer first-token');
    token = 'refreshed-token';
    await codes.find('save', state(b.getSnapshot()));
    expect(new Headers(fake.calls[1].init?.headers).get('Authorization')).toBe('Bearer refreshed-token');
  });

  it('omits variantId for a custom line', async () => {
    const b = builder();
    b.addLine({ ...item, custom: true });
    const fake = store();
    await provider(fake.fetchImpl).find('save', state(b.getSnapshot()));
    expect(fake.calls[0].body).toMatchObject({ lines: [{ netMinor: 1000 }] });
    expect(fake.calls[0].body).not.toHaveProperty('lines.0.variantId');
  });

  it('sends unit price times quantity for an undiscounted inclusive line', async () => {
    const b = builder(true);
    const id = b.addLine({ ...item, unitPrice: { amount: 1190, currency: 'EUR' }, quantity: 2 });
    const fake = store();
    await provider(fake.fetchImpl).find('save', state(b.getSnapshot()));
    expect(fake.calls[0].body).toEqual({ currency: 'EUR', codes: ['save'], lines: [
      { lineId: id, variantId: 'variant', quantity: 2, taxInclusive: true, netMinor: 2380, taxRatePpm: 190000 },
    ] });
  });

  it('refuses a discounted inclusive line without fetching', async () => {
    const b = builder(true);
    const id = b.addLine(item);
    b.applyLineDiscount(id, { type: 'percentage', value: 10 });
    const fake = store();
    await expect(provider(fake.fetchImpl).find('save', state(b.getSnapshot())))
      .resolves.toEqual({ refusal: COUPON_INCLUSIVE_DISCOUNT });
    expect(fake.fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses an empty order without fetching', async () => {
    const fake = store();
    await expect(provider(fake.fetchImpl).find('save', state(builder().getSnapshot())))
      .resolves.toEqual({ refusal: COUPON_NEEDS_ITEMS });
    expect(fake.fetchImpl).not.toHaveBeenCalled();
  });

  it('returns the store amounts under the till code even if the reply code differs', async () => {
    const fake = store({ coupons: [{ code: 'STORE-CODE', ...priced }] });
    const result = await provider(fake.fetchImpl).find('save', state(order()));
    expect(result).toMatchObject({ found: { coupon: priced, pricing: { codes: ['save'], priced: new Map([['save', priced]]) } } });
  });

  it('returns the first storeCode message in codes order', async () => {
    const fake = store({ coupons: [{ storeCode: 'expired', message: 'This coupon has expired' },
      { storeCode: 'not_found', message: 'Coupon not found' }] });
    const sale = state(order());
    sale.accepted = new Map([['first', { coupon: priced, pricing: { codes: ['first'], priced: new Map(), basis: '' } }]]);
    await expect(provider(fake.fetchImpl).find('second', sale)).resolves.toEqual({ refusal: 'This coupon has expired' });
    expect(fake.calls[0].body).toMatchObject({ codes: ['first', 'second'] });
  });

  it('returns a transient refusal when fetch rejects', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    await expect(provider(fetchImpl).find('save', state(order()))).resolves.toEqual(transient);
  });

  it('returns a transient refusal for a 503', async () => {
    await expect(provider(store({}, 503).fetchImpl).find('save', state(order()))).resolves.toEqual(transient);
  });

  it('returns a transient refusal for a 401', async () => {
    await expect(provider(store({}, 401).fetchImpl).find('save', state(order()))).resolves.toEqual(transient);
  });

  it('aborts a request that never resolves and returns a transient refusal', async () => {
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    expect(COUPON_PREVIEW_TIMEOUT_MS).toBe(15000);
    await expect(provider(fetchImpl, { timeoutMs: 5 }).find('save', state(order()))).resolves.toEqual(transient);
    expect(fetchImpl.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it('returns COUPON_CHECK_FAILED for a 400', async () => {
    await expect(provider(store({}, 400).fetchImpl).find('save', state(order())))
      .resolves.toEqual({ refusal: COUPON_CHECK_FAILED });
  });

  it('returns COUPON_CHECK_FAILED when fewer entries than codes are returned', async () => {
    await expect(provider(store({ coupons: [] }).fetchImpl).find('save', state(order())))
      .resolves.toEqual({ refusal: COUPON_CHECK_FAILED });
  });

  it('returns COUPON_CHECK_FAILED for an empty couponId', async () => {
    await expect(provider(store({ coupons: [{ ...priced, couponId: '' }] }).fetchImpl).find('save', state(order())))
      .resolves.toEqual({ refusal: COUPON_CHECK_FAILED });
  });

  it('includes order discounts and excludes existing coupons from the pricing basis', () => {
    const b = builder();
    const id = b.addLine(item);
    b.applyOrderDiscount({ type: 'percentage', value: 10 });
    b.setCoupons(['previous'], { kind: 'store-priced', basis: couponPricingBasis(b.getSnapshot()),
      priced: new Map([['previous', { couponId: 'previous', lines: [{ lineId: id, amountMinor: 137 }] }]]) });
    expect(couponPreviewRequest(['previous', 'save'], b.getSnapshot())).toMatchObject({ body: { lines: [{ netMinor: 900 }] } });
  });

  it.each(['', 'x'.repeat(65)])('omits an unsendable customer id (%j)', id => {
    const b = builder();
    b.addLine(item);
    b.setCustomer({ id, name: 'Customer' });
    expect(couponPreviewRequest(['save'], b.getSnapshot())).not.toHaveProperty('body.customerId');
  });

  it.each(['x', 'x'.repeat(64)])('includes a customer id at the length boundary (%j)', id => {
    const b = builder();
    b.addLine(item);
    b.setCustomer({ id, name: 'Customer' });
    expect(couponPreviewRequest(['save'], b.getSnapshot())).toHaveProperty('body.customerId', id);
  });

  it('returns a transient refusal for a 403', async () => {
    await expect(provider(store({}, 403).fetchImpl).find('save', state(order()))).resolves.toEqual(transient);
  });

  it.each([null, {}, { coupons: {} }, { coupons: [priced, priced] }])('refuses a malformed reply (%j)', async body => {
    await expect(provider(store(body).fetchImpl).find('save', state(order()))).resolves.toEqual({ refusal: COUPON_CHECK_FAILED });
  });

  it.each([undefined, '', 42])('uses the generic refusal for an invalid store message (%j)', async message => {
    await expect(provider(store({ coupons: [{ storeCode: 'expired', message }] }).fetchImpl).find('save', state(order())))
      .resolves.toEqual({ refusal: COUPON_CHECK_FAILED });
  });

  it.each([null, {}, [{ lineId: 4, amountMinor: 1 }], [{ lineId: 'l', amountMinor: -1 }],
    [{ lineId: 'l', amountMinor: 1.5 }], [{ lineId: 'l', amountMinor: Number.MAX_SAFE_INTEGER + 1 }],
    [{ lineId: 'l', amountMinor: '1' }]])('refuses malformed priced lines (%j)', async lines => {
    await expect(provider(store({ coupons: [{ couponId: 'promo', lines }] }).fetchImpl).find('save', state(order())))
      .resolves.toEqual({ refusal: COUPON_CHECK_FAILED });
  });

  it('refuses invalid JSON', async () => {
    const fetchImpl = vi.fn(async () => new Response('not json'));
    await expect(provider(fetchImpl).find('save', state(order()))).resolves.toEqual({ refusal: COUPON_CHECK_FAILED });
  });
});
