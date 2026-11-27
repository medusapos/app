import { expect, it, vi } from 'vitest';
import { authHeaders } from '../lib/pos-connector';
import { readStoreCoupons } from '../lib/store-coupons';

const session = { baseUrl: 'https://store.test', token: 'jwt' };
const coupon = { code: 'TEN', label: null, type: 'percentage', value: 10, currency: null, endsAt: null };
const body = { coupons: [coupon], limit: 100, truncated: true };
const reply = (data: unknown, status = 200) => vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(data), { status }));

it('does not request a list on plugin contract 7', async () => {
  const fetchImpl = reply(body);
  expect(await readStoreCoupons(session, 7, 'EUR', fetchImpl)).toBeNull();
  expect(fetchImpl).not.toHaveBeenCalled();
});

it.each([404, 500])('returns null on HTTP %i', async status => {
  expect(await readStoreCoupons(session, 8, 'EUR', reply(body, status))).toBeNull();
});

it('returns null on a network error', async () => {
  expect(await readStoreCoupons(session, 8, 'EUR', vi.fn<typeof fetch>().mockRejectedValue(new Error('offline')))).toBeNull();
});

it('aborts the fetch and returns null on timeout', async () => {
  const pending = vi.fn<typeof fetch>().mockReturnValue(new Promise<Response>(() => {}));
  const result = readStoreCoupons(session, 8, 'EUR', pending, 20);
  const signal = pending.mock.calls[0]?.[1]?.signal;
  expect(signal?.aborted).toBe(false);
  expect(await result).toBeNull();
  expect(signal?.aborted).toBe(true);
});

it('requests the currency with staff auth and returns the coupons and truncation flag', async () => {
  const fetchImpl = reply(body);
  expect(await readStoreCoupons(session, 8, 'EUR', fetchImpl)).toEqual({ coupons: [coupon], truncated: true });
  expect(fetchImpl).toHaveBeenCalledExactlyOnceWith('https://store.test/tally/v1/promotions?currency=EUR',
    { method: 'GET', headers: authHeaders('jwt'), signal: expect.any(AbortSignal) });
});

it('drops a coupon with the wrong value type and keeps the valid coupon', async () => {
  expect(await readStoreCoupons(session, 8, 'EUR', reply({ ...body, coupons: [coupon, { ...coupon, value: '10' }] })))
    .toEqual({ coupons: [coupon], truncated: true });
});

it('returns null when coupons is not an array', async () => {
  expect(await readStoreCoupons(session, 8, 'EUR', reply({ ...body, coupons: coupon }))).toBeNull();
});

it('accepts extra response and coupon fields without returning them', async () => {
  const fetchImpl = reply({ ...body, total: 1, coupons: [{ ...coupon, colour: 'red' }] });
  expect(await readStoreCoupons(session, 8, 'EUR', fetchImpl)).toStrictEqual({ coupons: [coupon], truncated: true });
});
