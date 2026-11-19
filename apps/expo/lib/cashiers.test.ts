import { describe, expect, it, vi } from 'vitest';
import { fetchCashiers, reportCashierOptions } from './cashiers';
import { authHeaders } from './pos-connector';

const session = { baseUrl: 'https://shop.test', token: 't0k' };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('fetchCashiers', () => {
  it('asks the store for its cashiers with the session token and values each by email', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => response({ cashiers: [
      { id: 'user_ana', email: 'ana@store.test', name: 'Ana' },
      { id: 'user_ben', email: 'ben@store.test', name: 'Ben Ito' },
    ] }));
    await expect(fetchCashiers(session, fetchImpl)).resolves.toEqual([
      { value: 'ana@store.test', label: 'Ana' }, { value: 'ben@store.test', label: 'Ben Ito' },
    ]);
    expect(fetchImpl).toHaveBeenCalledWith('https://shop.test/tally/v1/cashiers', { headers: authHeaders('t0k') });
  });

  it('skips a row without an email or a name', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => response({ cashiers: [
      { id: 'user_x', name: 'No email' }, { id: 'user_y', email: '', name: 'Empty' }, { id: 'user_z', email: 'z@store.test' },
      null, { id: 'user_ana', email: 'ana@store.test', name: 'Ana' },
    ] }));
    await expect(fetchCashiers(session, fetchImpl)).resolves.toEqual([{ value: 'ana@store.test', label: 'Ana' }]);
  });

  it('answers no cashiers when the request throws, an older plugin answers 404, or the body has no list', async () => {
    await expect(fetchCashiers(session, vi.fn<typeof fetch>(async () => { throw new TypeError('offline'); }))).resolves.toEqual([]);
    await expect(fetchCashiers(session, vi.fn<typeof fetch>(async () => response({ message: 'Not found' }, 404)))).resolves.toEqual([]);
    await expect(fetchCashiers(session, vi.fn<typeof fetch>(async () => response({ users: [] })))).resolves.toEqual([]);
    await expect(fetchCashiers(session, vi.fn<typeof fetch>(async () => new Response('not json')))).resolves.toEqual([]);
  });
});

describe('reportCashierOptions', () => {
  const ana = { value: 'ana@store.test', label: 'Ana' };
  const ben = { value: 'ben@store.test', label: 'Ben' };

  it('adds the signed-in user when the list lacks them, by name or else by email', () => {
    expect(reportCashierOptions([ben, ana], { email: 'cat@store.test', name: 'Cat' }))
      .toEqual([ana, ben, { value: 'cat@store.test', label: 'Cat' }]);
    expect(reportCashierOptions([], { email: 'admin@store.test' }))
      .toEqual([{ value: 'admin@store.test', label: 'admin@store.test' }]);
  });

  it('lists the signed-in user once when the store already has them, and each value once', () => {
    expect(reportCashierOptions([ben, ana, { value: 'ana@store.test', label: 'Ana again' }], { email: 'ana@store.test', name: 'Me' }))
      .toEqual([ana, ben]);
  });

  it('sorts by label', () => {
    expect(reportCashierOptions([{ value: 'z@store.test', label: 'zoe' }, ben], { email: 'ana@store.test', name: 'Ana' })
      .map((option) => option.label)).toEqual(['Ana', 'Ben', 'zoe']);
  });
});
