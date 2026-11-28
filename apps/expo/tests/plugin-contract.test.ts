import { describe, expect, it, vi } from 'vitest';
import { MIN_PLUGIN_CONTRACT, pluginContractStatus, readPluginContract, readPluginContractVersion, readPluginInfoSummary } from '../lib/plugin-contract';
import { authHeaders } from '../lib/pos-connector';

const session = { baseUrl: 'https://store.test', token: 'jwt' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const fetchReturning = (response: Response) => vi.fn<typeof fetch>().mockResolvedValue(response);

describe('pluginContractStatus', () => {
  it.each([
    [null, 'unknown'], ['x', 'unknown'], [{}, 'unknown'], [{ contracts: null }, 'unknown'],
    // An info body from a plugin before pluginContract, or with a value that is not a supported integer, is too old.
    [{ contracts: {} }, 'too_old'], [{ contracts: {}, pluginContract: 0 }, 'too_old'], [{ contracts: {}, pluginContract: '1' }, 'too_old'],
    [{ contracts: {}, pluginContract: 1.5 }, 'too_old'], [{ contracts: {}, pluginContract: MIN_PLUGIN_CONTRACT - 1 }, 'too_old'],
    [{ contracts: {}, pluginContract: MIN_PLUGIN_CONTRACT }, 'ok'], [{ contracts: {}, pluginContract: MIN_PLUGIN_CONTRACT + 1 }, 'ok'],
    // A newer plugin (contract 3 adds GET /tally/v1/orders) must not latch "Update required".
    [{ contracts: {}, pluginContract: 3 }, 'ok'],
  ])('%j is %s', (body, expected) => {
    expect(pluginContractStatus(body)).toBe(expected);
  });
});

describe('readPluginContract', () => {
  it('reads GET /tally/v1/info with the session token and passes a current plugin', async () => {
    const fetchImpl = fetchReturning(json({ contracts: { 'order.create': [7] }, pluginContract: MIN_PLUGIN_CONTRACT }));
    expect(await readPluginContract(session, fetchImpl)).toBe('ok');
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith('https://store.test/tally/v1/info',
      expect.objectContaining({ method: 'GET', headers: expect.objectContaining({ Authorization: authHeaders('jwt').Authorization }) }));
  });

  it('reports a plugin without pluginContract as too old', async () => {
    expect(await readPluginContract(session, fetchReturning(json({ contracts: { 'order.create': [7] } })))).toBe('too_old');
  });

  it.each([
    ['a rejected fetch', () => vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Failed to fetch'))],
    ['a 500', () => fetchReturning(json({ contracts: {} }, 500))],
    ['a 403', () => fetchReturning(json({ contracts: {} }, 403))],
    ['a non-JSON 200', () => fetchReturning(new Response('<html>', { status: 200 }))],
  ])('is unknown on %s', async (_label, makeFetch) => {
    expect(await readPluginContract(session, makeFetch())).toBe('unknown');
  });

  it('is unknown when no response arrives within the timeout', async () => {
    const never = vi.fn<typeof fetch>().mockReturnValue(new Promise<Response>(() => {}));
    expect(await readPluginContract(session, never, 20)).toBe('unknown');
  });
});

describe('readPluginContractVersion', () => {
  it.each([
    ['a current plugin', () => fetchReturning(json({ contracts: {}, pluginContract: 2 })), 2],
    ['a plugin before pluginContract', () => fetchReturning(json({ contracts: {} })), 0],
    ['a 500', () => fetchReturning(json({ contracts: {}, pluginContract: 2 }, 500)), null],
    ['a rejected fetch', () => vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Failed to fetch')), null],
    ['a body without contracts', () => fetchReturning(json({ pluginContract: 2 })), null],
  ])('reads %s', async (_label, makeFetch, expected) => {
    expect(await readPluginContractVersion(session, makeFetch())).toBe(expected);
  });
});

it('readPluginInfoSummary returns the contract and the trimmed version from one /info read', async () => {
  const fetchImpl = fetchReturning(json({ contracts: {}, pluginContract: 8, pluginVersion: ' 0.3.0 ' }));
  expect(await readPluginInfoSummary(session, fetchImpl)).toEqual({ contract: 8, version: '0.3.0' });
  expect(fetchImpl).toHaveBeenCalledExactlyOnceWith('https://store.test/tally/v1/info', expect.anything());
});

it.each([
  { contracts: {}, pluginContract: 8 },
  { contracts: {}, pluginContract: 8, pluginVersion: null },
  { contracts: {}, pluginContract: 8, pluginVersion: 3 },
  { contracts: {}, pluginContract: 8, pluginVersion: '' },
])('readPluginInfoSummary: a missing, null, numeric or empty pluginVersion is null', async (body) => {
  expect(await readPluginInfoSummary(session, fetchReturning(json(body)))).toEqual({ contract: 8, version: null });
});

it.each([
  json({ contracts: {}, pluginContract: 8, pluginVersion: '0.3.0' }, 500), json({}),
])('readPluginInfoSummary: a failed read or a non-info body gives both null', async (response) => {
  expect(await readPluginInfoSummary(session, fetchReturning(response))).toEqual({ contract: null, version: null });
});
