import { describe, expect, it, vi } from 'vitest';
import {
  clearSession, defaultStorage, isPrivateHost, loadSession, login, LoginError, normalizeBaseUrl,
  REFRESH_WINDOW_MS, refreshSession, saveSession, shouldRefresh, tokenExpiresAt,
  type SessionStorage,
} from './session';

const session = { baseUrl: 'http://localhost:9000', email: 'admin@tally.test', token: 'jwt' };
const response = (body: unknown, status = 200) => vi.fn<() => Promise<Response>>().mockResolvedValue(
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
);
const jwt = (payload: unknown) => `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify(payload))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}.signature`;
function memoryStorage(): SessionStorage {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); },
    removeItem: (key) => { data.delete(key); },
  };
}

describe('normalizeBaseUrl', () => {
  it('trims whitespace and trailing slashes', () => {
    expect(normalizeBaseUrl('  https://store.test///  ')).toBe('https://store.test');
    expect(normalizeBaseUrl(session.baseUrl)).toBe(session.baseUrl);
  });
  it.each(['ftp://store.test', 'store.test', '', 'https://'])('rejects %j', (url) => {
    expect(() => normalizeBaseUrl(url)).toThrow(LoginError);
    expect(() => normalizeBaseUrl(url)).toThrow(expect.objectContaining({ code: 'invalid_url' }));
  });
  it.each([
    'https://shop.example.com', 'http://localhost:9000', 'http://store.localhost',
    'http://127.0.0.1', 'http://127.255.255.255', 'http://10.20.30.40',
    'http://172.16.0.1', 'http://172.31.255.254', 'http://192.168.1.2', 'http://[::1]:9000',
  ])('allows %s', (url) => {
    expect(normalizeBaseUrl(url)).toBe(url);
  });
  it.each(['http://172.32.0.1', 'http://172.15.255.255', 'http://shop.example.com', 'http://8.8.8.8'])(
    'requires HTTPS for %s', (url) => {
      expect(() => normalizeBaseUrl(url)).toThrow(expect.objectContaining({ code: 'insecure_url' }));
    },
  );
});

describe('isPrivateHost', () => {
  it.each(['localhost', 'store.localhost', '127.0.0.1', '127.2.3.4', '10.0.0.1',
    '172.16.0.1', '172.31.255.255', '192.168.0.1', '[::1]'])('recognizes %s', (hostname) => {
    expect(isPrivateHost(hostname)).toBe(true);
  });
  it.each(['172.32.0.1', '172.15.0.1', '192.169.0.1', '8.8.8.8', '10.0.0.256',
    'shop.example.com', 'localhost.example.com', 'notlocalhost', '[::2]', 'garbage'])(
    'rejects %s', (hostname) => { expect(isPrivateHost(hostname)).toBe(false); },
  );
});

describe('login', () => {
  it('signs in without a name after a user request hangs for three seconds', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = response({ token: 'jwt' })
        .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'jwt' })))
        .mockImplementationOnce(() => new Promise<Response>(() => {}));
      const resolved = vi.fn();
      const result = login(session.baseUrl, session.email, 'secret', fetchImpl).then(resolved);
      await vi.advanceTimersByTimeAsync(2999);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(resolved).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(resolved).toHaveBeenCalledWith(session);
      await result;
    } finally { vi.useRealTimers(); }
  });
  it('reads the signed-in user name and preserves it in session storage', async () => {
    const fetchImpl = response({ user: { first_name: ' Alex', last_name: 'Shopkeeper ' } })
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'jwt' })));
    const result = await login(session.baseUrl, session.email, 'secret', fetchImpl);
    expect(result).toEqual({ ...session, name: 'Alex Shopkeeper' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenNthCalledWith(2, `${session.baseUrl}/admin/users/me`, {
      method: 'GET', headers: { Authorization: 'Bearer jwt' },
    });
    const storage = memoryStorage();
    saveSession(storage, result);
    expect(loadSession(storage)).toEqual(result);
  });
  it.each([
    new TypeError('offline'), new Response('{}', { status: 500 }),
    new Response('not json'), new Response('{}'), new Response('{"user":{}}'),
    new Response('{"user":{"first_name":" ","last_name":null}}'),
  ])('still signs in without a name when the user read fails or has no name: %s', async (result) => {
    const fetchImpl = response({ token: 'jwt' });
    fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify({ token: 'jwt' })));
    if (result instanceof Error) fetchImpl.mockRejectedValueOnce(result);
    else fetchImpl.mockResolvedValueOnce(result);
    await expect(login(session.baseUrl, session.email, 'secret', fetchImpl)).resolves.toEqual(session);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it('rejects public HTTP before sending the password', async () => {
    const fetchImpl = response({ token: 'jwt' });
    await expect(login('http://shop.example.com', session.email, 'secret', fetchImpl))
      .rejects.toMatchObject({ code: 'insecure_url' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('posts credentials and returns a session with a normalized URL', async () => {
    const fetchImpl = response({ token: 'jwt' });
    await expect(login(` ${session.baseUrl}/ `, session.email, 'secret', fetchImpl)).resolves.toEqual(session);
    expect(fetchImpl).toHaveBeenCalledWith(`${session.baseUrl}/auth/user/emailpass`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: session.email, password: 'secret' }),
    });
  });
  it.each([
    [401, {}, 'invalid_credentials'],
    [200, { mfa_required: true, token: 'unusable' }, 'unsupported_account'],
    [200, { verification_required: true, token: 'unusable' }, 'unsupported_account'],
    [200, { location: '/verify', token: 'unusable' }, 'unsupported_account'],
    [500, {}, 'server_error'],
    [200, {}, 'server_error'],
    [200, { token: 123 }, 'server_error'],
    [200, null, 'server_error'],
  ])('maps status %s and body %j to %s', async (status, body, code) => {
    await expect(login(session.baseUrl, session.email, 'secret', response(body, status)))
      .rejects.toMatchObject({ code });
  });
  it('maps a thrown fetch to unreachable', async () => {
    const fetchImpl = vi.fn<() => Promise<Response>>().mockRejectedValue(new TypeError('offline'));
    await expect(login(session.baseUrl, session.email, 'secret', fetchImpl))
      .rejects.toMatchObject({ code: 'unreachable' });
  });
  it('maps malformed JSON to server_error', async () => {
    const fetchImpl = vi.fn<() => Promise<Response>>().mockResolvedValue(new Response('not json'));
    await expect(login(session.baseUrl, session.email, 'secret', fetchImpl))
      .rejects.toMatchObject({ code: 'server_error' });
  });
});

describe('refreshSession', () => {
  it('posts the bearer token and replaces only the token', async () => {
    const fetchImpl = response({ token: 'new-jwt' });
    await expect(refreshSession(session, fetchImpl)).resolves.toEqual({ ...session, token: 'new-jwt' });
    expect(fetchImpl).toHaveBeenCalledWith(`${session.baseUrl}/auth/token/refresh`, {
      method: 'POST', headers: { Authorization: 'Bearer jwt' },
    });
    expect(session.token).toBe('jwt');
  });
  it.each([
    [401, {}, 'invalid_credentials'], [500, {}, 'server_error'],
    [200, {}, 'server_error'], [200, { token: 123 }, 'server_error'],
  ])('maps status %s and body %j to %s', async (status, body, code) => {
    await expect(refreshSession(session, response(body, status))).rejects.toMatchObject({ code });
  });
  it('maps a thrown fetch to unreachable', async () => {
    const fetchImpl = vi.fn<() => Promise<Response>>().mockRejectedValue(new TypeError('offline'));
    await expect(refreshSession(session, fetchImpl)).rejects.toMatchObject({ code: 'unreachable' });
  });
});

describe('token expiry', () => {
  const now = 1_800_000_000_000;
  it('decodes a JWT expiry in epoch milliseconds', () => {
    expect(tokenExpiresAt(jwt({ sub: 'user_123', exp: now / 1000, note: '??>>' }))).toBe(now);
  });
  it.each(['garbage', 'a.!.c', 'a.e30.c', jwt({ exp: '123' }), jwt({ exp: null })])(
    'returns null for absent or malformed expiry: %s', (token) => {
      expect(tokenExpiresAt(token)).toBeNull();
    },
  );
  it('refreshes expired, unreadable, and near-expiry tokens only', () => {
    expect(REFRESH_WINDOW_MS).toBe(6 * 60 * 60 * 1000);
    expect(shouldRefresh(jwt({ exp: (now + REFRESH_WINDOW_MS + 1000) / 1000 }), now)).toBe(false);
    expect(shouldRefresh(jwt({ exp: (now + REFRESH_WINDOW_MS) / 1000 }), now)).toBe(true);
    expect(shouldRefresh(jwt({ exp: (now + 1000) / 1000 }), now)).toBe(true);
    expect(shouldRefresh(jwt({ exp: (now - 1000) / 1000 }), now)).toBe(true);
    expect(shouldRefresh('garbage', now)).toBe(true);
  });
});

describe('session storage', () => {
  it('round-trips and clears the session without saving a password', () => {
    const storage = memoryStorage();
    expect(loadSession(storage)).toBeNull();
    saveSession(storage, { ...session, password: 'never stored' } as typeof session);
    expect(JSON.parse(storage.getItem('medusapos.session')!)).toEqual(session);
    expect(JSON.parse(storage.getItem('medusapos.session')!)).not.toHaveProperty('password');
    expect(loadSession(storage)).toEqual(session);
    clearSession(storage);
    expect(storage.getItem('medusapos.session')).toBeNull();
    expect(loadSession(storage)).toBeNull();
  });
  it.each(['not json', 'null', '{}', '[]', '{"baseUrl":1,"email":"a","token":"b"}'])(
    'ignores malformed stored data: %s', (data) => {
      const storage = memoryStorage();
      storage.setItem('medusapos.session', data);
      expect(loadSession(storage)).toBeNull();
    },
  );
  it('accepts null storage', () => {
    expect(loadSession(null)).toBeNull();
    expect(() => saveSession(null, session)).not.toThrow();
    expect(() => clearSession(null)).not.toThrow();
  });
  it('tolerates storage access failures', () => {
    const fail = () => { throw new Error('storage unavailable'); };
    const storage = { getItem: fail, setItem: fail, removeItem: fail };
    expect(loadSession(storage)).toBeNull();
    expect(() => saveSession(storage, session)).not.toThrow();
    expect(() => clearSession(storage)).not.toThrow();
  });
  it('uses web storage when available and returns null when unavailable', () => {
    const storage = memoryStorage();
    try {
      vi.stubGlobal('localStorage', storage);
      expect(defaultStorage()).toBe(storage);
      vi.stubGlobal('localStorage', undefined);
      expect(defaultStorage()).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
