import { authHeaders } from './pos-connector';

export type Session = { baseUrl: string; email: string; token: string; name?: string };
export type LoginErrorCode = 'invalid_credentials' | 'unsupported_account' | 'unreachable' | 'server_error' | 'invalid_url' | 'insecure_url';
export class LoginError extends Error {
  constructor(readonly code: LoginErrorCode, message: string) { super(message); }
}

// Refresh with six hours left: Medusa's default token lifetime is one day.
export const REFRESH_WINDOW_MS = 6 * 60 * 60 * 1000;
const STORAGE_KEY = 'medusapos.session';
export type SessionStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isPrivateHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '[::1]') return true;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return false;
  const octets = hostname.split('.').map(Number);
  if (octets.some((octet) => octet > 255)) return false;
  const [a, b] = octets;
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function normalizeBaseUrl(input: string): string {
  const baseUrl = input.trim().replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch { throw new LoginError('invalid_url', 'Enter a valid backend URL starting with https://.'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new LoginError('invalid_url', 'Enter a valid backend URL starting with https://.');
  }
  if (url.protocol === 'http:' && !isPrivateHost(url.hostname)) {
    throw new LoginError('insecure_url', 'Use https://. Plain http:// is only allowed for localhost and private network addresses.');
  }
  return baseUrl;
}

export async function login(baseUrl: string, email: string, password: string, fetchImpl = globalThis.fetch): Promise<Session> {
  baseUrl = normalizeBaseUrl(baseUrl);
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/auth/user/emailpass`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  } catch { throw new LoginError('unreachable', 'Could not reach the backend.'); }
  if (response.status === 401) throw new LoginError('invalid_credentials', 'Incorrect email or password.');
  if (!response.ok) throw new LoginError('server_error', 'The backend could not sign you in.');
  const body: unknown = await response.json().catch(() => null);
  if (isRecord(body) && (body.mfa_required === true || body.verification_required === true || body.location !== undefined)) {
    throw new LoginError('unsupported_account', 'This account requires an unsupported sign-in flow.');
  }
  if (!isRecord(body) || typeof body.token !== 'string') throw new LoginError('server_error', 'The backend returned no token.');
  const session: Session = { baseUrl, email, token: body.token };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const profile: unknown = await Promise.race([
      fetchImpl(`${baseUrl}/admin/users/me`, {
        method: 'GET', headers: authHeaders(session.token),
      }).then((response) => response.ok ? response.json() : null),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), 3000); }),
    ]);
    if (profile) {
      if (isRecord(profile) && isRecord(profile.user)) {
        const name = [profile.user.first_name, profile.user.last_name]
          .filter((part) => typeof part === 'string').join(' ').trim();
        if (name) session.name = name;
      }
    }
  } catch { /* The cashier name is optional; keep the successful login. */ }
  finally { clearTimeout(timer); }
  return session;
}

export async function refreshSession(session: Session, fetchImpl = globalThis.fetch): Promise<Session> {
  let response: Response;
  try {
    response = await fetchImpl(`${session.baseUrl}/auth/token/refresh`, {
      method: 'POST', headers: authHeaders(session.token),
    });
  } catch { throw new LoginError('unreachable', 'Could not reach the backend.'); }
  if (response.status === 401) throw new LoginError('invalid_credentials', 'Please sign in again.');
  if (!response.ok) throw new LoginError('server_error', 'The backend could not refresh the session.');
  const body: unknown = await response.json().catch(() => null);
  if (!isRecord(body) || typeof body.token !== 'string') throw new LoginError('server_error', 'The backend returned no token.');
  return { ...session, token: body.token };
}

export function tokenExpiresAt(token: string): number | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const value: unknown = JSON.parse(atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, '=')));
    if (!isRecord(value)) return null;
    const { exp } = value;
    return typeof exp === 'number' && Number.isFinite(exp * 1000) ? exp * 1000 : null;
  } catch { return null; }
}

export function shouldRefresh(token: string, now: number): boolean {
  const expiry = tokenExpiresAt(token);
  return expiry === null || expiry <= now + REFRESH_WINDOW_MS;
}

export function defaultStorage(): SessionStorage | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

export function loadSession(storage: SessionStorage | null): Session | null {
  try {
    const value: unknown = JSON.parse(storage?.getItem(STORAGE_KEY) ?? 'null');
    if (!isRecord(value) || typeof value.baseUrl !== 'string' || typeof value.email !== 'string' || typeof value.token !== 'string') return null;
    return { baseUrl: value.baseUrl, email: value.email, token: value.token,
      name: typeof value.name === 'string' ? value.name : undefined };
  } catch { return null; }
}

export function saveSession(storage: SessionStorage | null, session: Session): void {
  try {
    const { baseUrl, email, token, name } = session;
    storage?.setItem(STORAGE_KEY, JSON.stringify({ baseUrl, email, token, name }));
  } catch { /* Keep the in-memory session when web storage is unavailable. */ }
}

export function clearSession(storage: SessionStorage | null): void {
  try { storage?.removeItem(STORAGE_KEY); } catch { /* Web storage may be unavailable. */ }
}
