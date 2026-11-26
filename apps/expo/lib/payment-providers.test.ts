import { describe, expect, it, vi } from 'vitest';
import { fetchPaymentProviders } from './payment-providers';

const session = { baseUrl: 'https://store.test', token: 'tok_123' };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('fetchPaymentProviders', () => {
  it('returns the providers and drops a malformed row', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(200, { providers: [
      { id: 'pp_system_default', name: 'Manual payment', tillCanTake: true },
      { id: 'pp_stripe_stripe', name: 'Stripe' },
      { id: 'pp_acme-pay_acme', name: 'Acme Pay', tillCanTake: false },
    ] }));
    await expect(fetchPaymentProviders(session, fetchImpl)).resolves.toEqual([
      { id: 'pp_system_default', name: 'Manual payment', tillCanTake: true, terminal: false },
      { id: 'pp_acme-pay_acme', name: 'Acme Pay', tillCanTake: false, terminal: false },
    ]);
  });

  it('asks the plugin route with the session bearer token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(200, { providers: [] }));
    await fetchPaymentProviders(session, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://store.test/tally/v1/payment-providers');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer tok_123');
  });

  it("passes the till's region as region_id, URL-encoded", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(200, { providers: [] }));
    await fetchPaymentProviders(session, fetchImpl, 'reg 1/é');
    expect(fetchImpl.mock.calls[0][0]).toBe('https://store.test/tally/v1/payment-providers?region_id=reg%201%2F%C3%A9');
  });

  it('reads terminal only when it is exactly true', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(200, { providers: [
      { id: 'pp_a', name: 'A', tillCanTake: false, terminal: true },
      { id: 'pp_b', name: 'B', tillCanTake: false, terminal: 'true' },
      { id: 'pp_c', name: 'C', tillCanTake: false },
      { id: 'pp_d', name: 'D', tillCanTake: false, terminal: 1 },
    ] }));
    const providers = await fetchPaymentProviders(session, fetchImpl);
    expect(providers?.map((provider) => provider.terminal)).toEqual([true, false, false, false]);
  });

  it('returns null on a 404 from an older plugin', async () => {
    await expect(fetchPaymentProviders(session, vi.fn().mockResolvedValue(json(404, { message: 'Not found' })))).resolves.toBeNull();
  });

  it('returns null when the fetch rejects', async () => {
    await expect(fetchPaymentProviders(session, vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))).resolves.toBeNull();
  });

  it('returns null on a body without a providers array', async () => {
    await expect(fetchPaymentProviders(session, vi.fn().mockResolvedValue(json(200, { providers: 'none' })))).resolves.toBeNull();
  });
});
