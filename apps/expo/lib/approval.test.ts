import { describe, expect, it, vi } from 'vitest';
import { APPROVAL_TIMEOUT_MS, ApprovalError, loadApprovers, rememberApprover, requestApproval, requestStoreApproval } from './approval';
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

const request = (email: string, password: string, fetch: ReturnType<typeof medusa>, options: { signal?: AbortSignal; timeoutMs?: number } = {}) =>
  requestApproval(baseUrl, email, password, { fetchImpl: fetch as unknown as typeof globalThis.fetch, ...options });
/** A sign-in that never answers and ignores its signal (the worst network): only the timeout or Cancel ends it. */
const hung = () => medusa({}, () => new Promise<Response>(() => {}));

describe('requestApproval', () => {
  it('signs in as the approver and resolves their Medusa user id and name, reading /me with that token', async () => {
    const fetch = medusa({ user: { id: 'user_mgr', first_name: 'Mia', last_name: 'Manager', email: 'mia@store.test' } });
    await expect(request('mia@store.test', 'pw', fetch)).resolves.toEqual({ approvedBy: 'user_mgr', approvedByName: 'Mia Manager' });
    const me = fetch.mock.calls.filter(([url]) => String(url) === `${baseUrl}/admin/users/me`);
    expect(me.length).toBeGreaterThan(0);
    for (const [, init] of me) expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer approver-token');
    // Every request carries the approval's abort signal.
    for (const [, init] of fetch.mock.calls) expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    [{ id: 'user_mgr', first_name: null, last_name: null, email: 'mia@store.test' }, 'mia@store.test'],
    [{ id: 'user_mgr' }, 'typed@store.test'],
  ])('names an approver without a first or last name by their email (%j)', async (user, name) => {
    await expect(request('typed@store.test', 'pw', medusa({ user }))).resolves.toEqual({ approvedBy: 'user_mgr', approvedByName: name });
  });

  it('refuses a wrong password as invalid', async () => {
    const fetch = medusa({}, () => json({ message: 'Invalid email or password' }, 401));
    await expect(request('mia@store.test', 'wrong', fetch)).rejects.toEqual(new ApprovalError('invalid', "That email and password didn't work."));
  });

  it.each([
    ['sign-in', medusa({}, () => { throw new TypeError('Failed to fetch'); })],
    ['/me', medusa(() => { throw new TypeError('Failed to fetch'); })],
  ])('is offline when the %s request cannot reach the backend', async (_step, fetch) => {
    await expect(request('mia@store.test', 'pw', fetch)).rejects.toMatchObject({ code: 'offline' });
  });

  it.each([[{ user: {} }], [{}]])('fails without a user id from /me (%j)', async (me) => {
    await expect(request('mia@store.test', 'pw', medusa(me))).rejects.toMatchObject({ code: 'failed' });
  });

  it('gives up as offline after APPROVAL_TIMEOUT_MS when the network never answers, aborting the request', async () => {
    vi.useFakeTimers();
    try {
      const fetch = hung();
      const result = request('mia@store.test', 'pw', fetch).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(APPROVAL_TIMEOUT_MS - 1);
      expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await result).toMatchObject({ code: 'offline' });
      expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('a Cancel (the caller\'s signal) aborts the request and rejects as cancelled at once', async () => {
    const fetch = hung();
    const controller = new AbortController();
    const result = request('mia@store.test', 'pw', fetch, { signal: controller.signal }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    controller.abort();
    expect(await result).toMatchObject({ code: 'cancelled' });
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
});

describe('requestStoreApproval', () => {
  const ask = { sessionId: 'sess_1', variance: { cash: -1200 }, email: 'mia@store.test', password: 'secret-pw' };
  const route = (answer: () => Response | Promise<Response>) => vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => answer());
  const proof = { approval: 'proof-abc', approvedBy: 'user_mgr', approvedByName: 'Mia Manager', expiresAt: '2026-11-10T19:00:00.000Z' };
  const storeRequest = (fetch: ReturnType<typeof route>, options: { signal?: AbortSignal; timeoutMs?: number } = {}) =>
    requestStoreApproval(`${baseUrl}/`, 'cashier-token', ask, { fetchImpl: fetch as unknown as typeof globalThis.fetch, ...options });

  it("posts the session, variance and credentials to the approval route with the cashier's token", async () => {
    const fetch = route(() => json(proof));
    await expect(storeRequest(fetch)).resolves.toEqual(proof);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe(`${baseUrl}/tally/v1/register-approvals`);
    expect(String(url)).not.toContain('secret-pw');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toStrictEqual(ask);
    const headers = new Headers(init?.headers);
    expect(headers.get('Authorization')).toBe('Bearer cashier-token');
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  const failed = "Couldn't check the approval. Try again.";
  it.each([
    [401, { code: 'approval_invalid_credentials', message: "The manager's email or password is not correct." }, 'invalid', "That email and password didn't work."],
    [401, { code: 'approval_mfa_unsupported', message: 'Needs a second step.' }, 'failed', 'Needs a second step.'],
    [403, { code: 'approval_forbidden', message: "This user can't approve register variances." }, 'failed', "This user can't approve register variances."],
    [409, { code: 'approval_session_unknown', message: 'This register session is not known to the store.' }, 'failed', 'This register session is not known to the store.'],
    [409, { code: 'approval_session_closed', message: 'This register session is already closed.' }, 'failed', 'This register session is already closed.'],
    [429, { code: 'approval_rate_limited', message: 'Too many failed approvals.' }, 'failed', 'Too many failed approvals.'],
    [403, { code: 'approval_forbidden' }, 'failed', failed],
    [429, { code: 'approval_rate_limited', message: 42 }, 'failed', failed],
    [400, { code: 'invalid_payload', message: 'sessionId: expected a string' }, 'failed', failed],
    [401, { message: 'Unauthorized' }, 'failed', failed],
    [500, { code: 'unknown_error', message: 'An unknown error occurred.' }, 'failed', failed],
  ])("maps each refusal code to the dialog's message (%i %j)", async (status, body, code, message) => {
    await expect(storeRequest(route(() => json(body, status)))).rejects.toEqual(new ApprovalError(code as ApprovalError['code'], message));
  });

  it('maps a network failure to offline', async () => {
    await expect(storeRequest(route(() => { throw new TypeError('Failed to fetch'); }))).rejects.toMatchObject({ code: 'offline' });
  });

  it.each([
    [{ approvedBy: 'user_mgr', approvedByName: 'Mia' }], [{ approval: 'proof-abc', approvedByName: 'Mia' }],
    [{ approval: '', approvedBy: 'user_mgr' }], [{ approval: 'proof-abc', approvedBy: 7 }], [null], ['not an object'],
  ])('a malformed approval answer fails (%j)', async (body) => {
    await expect(storeRequest(route(() => json(body)))).rejects.toEqual(new ApprovalError('failed', failed));
  });

  it('cancel aborts the request', async () => {
    const fetch = route(() => new Promise<Response>(() => {}));
    const controller = new AbortController();
    const result = storeRequest(fetch, { signal: controller.signal }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    controller.abort();
    expect(await result).toMatchObject({ code: 'cancelled' });
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it('a request that never answers fails as offline', async () => {
    vi.useFakeTimers();
    try {
      const fetch = route(() => new Promise<Response>(() => {}));
      const result = storeRequest(fetch).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(APPROVAL_TIMEOUT_MS - 1);
      expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await result).toMatchObject({ code: 'offline' });
      expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
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
