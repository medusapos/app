import { describe, expect, it, vi } from 'vitest';
import {
  clearSession, defaultStorage, loadSession, login, LoginError, normalizeBaseUrl,
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
    expect(() => normalizeBaseUrl(url)).toThrow(expect.objectContaining({ code: 'unreachable' }));
  });
});

describe('login', () => {
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
