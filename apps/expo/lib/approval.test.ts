import { describe, expect, it, vi } from 'vitest';
import { ApprovalError, loadApprovers, rememberApprover, requestApproval } from './approval';
import type { SessionStorage } from './session';

const baseUrl = 'https://store.test';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Medusa's emailpass sign-in, the plugin's info (404: an old plugin) and /admin/users/me. */
function medusa(me: unknown, signIn: () => Response | Promise<Response> = () => json({ token: 'approver-token' })) {
  return vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path === '/auth/user/emailpass') return signIn();
    if (path === '/admin/users/me') return typeof me === 'function' ? (me as () => Response)() : json(me);
    return json({}, 404);
  });
}

function memoryStorage(): SessionStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); }, removeItem: (key) => { data.delete(key); } };
}

describe('requestApproval', () => {
  it('signs in as the approver and resolves their Medusa user id and name, reading /me with that token', async () => {
    const fetch = medusa({ user: { id: 'user_mgr', first_name: 'Mia', last_name: 'Manager', email: 'mia@store.test' } });
    await expect(requestApproval(baseUrl, 'mia@store.test', 'pw', fetch)).resolves
      .toEqual({ approvedBy: 'user_mgr', approvedByName: 'Mia Manager' });
    const me = fetch.mock.calls.filter(([url]) => String(url) === `${baseUrl}/admin/users/me`);
    expect(me.length).toBeGreaterThan(0);
    for (const [, init] of me) expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer approver-token');
  });

  it.each([
    [{ id: 'user_mgr', first_name: null, last_name: null, email: 'mia@store.test' }, 'mia@store.test'],
    [{ id: 'user_mgr' }, 'typed@store.test'],
  ])('names an approver without a first or last name by their email (%j)', async (user, name) => {
    await expect(requestApproval(baseUrl, 'typed@store.test', 'pw', medusa({ user }))).resolves
      .toEqual({ approvedBy: 'user_mgr', approvedByName: name });
  });

  it('refuses a wrong password as invalid', async () => {
    const fetch = medusa({}, () => json({ message: 'Invalid email or password' }, 401));
    await expect(requestApproval(baseUrl, 'mia@store.test', 'wrong', fetch)).rejects
      .toEqual(new ApprovalError('invalid', "That email and password didn't work."));
  });

  it.each([
    ['sign-in', medusa({}, () => { throw new TypeError('Failed to fetch'); })],
    ['/me', medusa(() => { throw new TypeError('Failed to fetch'); })],
  ])('is offline when the %s request cannot reach the backend', async (_step, fetch) => {
    await expect(requestApproval(baseUrl, 'mia@store.test', 'pw', fetch)).rejects.toMatchObject({ code: 'offline' });
  });

  it.each([[{ user: {} }], [{}]])('fails without a user id from /me (%j)', async (me) => {
    await expect(requestApproval(baseUrl, 'mia@store.test', 'pw', medusa(me))).rejects.toMatchObject({ code: 'failed' });
  });
});

describe('the approver names', () => {
  it('keeps ids and names per backend, replacing a repeat', () => {
    const storage = memoryStorage();
    rememberApprover(storage, baseUrl, 'user_mgr', 'Mia');
    rememberApprover(storage, baseUrl, 'user_owner', 'Olly Owner');
    rememberApprover(storage, baseUrl, 'user_mgr', 'Mia Manager');
    expect(loadApprovers(storage, baseUrl)).toEqual({ user_owner: 'Olly Owner', user_mgr: 'Mia Manager' });
    expect(loadApprovers(storage, 'https://other.test')).toEqual({});
    expect([...storage.data.keys()]).toEqual([`medusapos.approvers.${baseUrl}`]);
  });

  it.each(['not json', '[1]', '{"user_mgr": 5}'])('reads a corrupt entry (%j) as no names', (value) => {
    const storage = memoryStorage();
    storage.setItem(`medusapos.approvers.${baseUrl}`, value);
    expect(loadApprovers(storage, baseUrl)).toEqual({});
  });
});
