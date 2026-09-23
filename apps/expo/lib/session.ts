export type Session = { baseUrl: string; email: string; token: string };
export type LoginErrorCode = 'invalid_credentials' | 'unsupported_account' | 'unreachable' | 'server_error';
export class LoginError extends Error {
  constructor(readonly code: LoginErrorCode, message: string) { super(message); }
}

// Refresh with six hours left: Medusa's default token lifetime is one day.
export const REFRESH_WINDOW_MS = 6 * 60 * 60 * 1000;
const STORAGE_KEY = 'medusapos.session';
export type SessionStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function normalizeBaseUrl(input: string): string {
  const baseUrl = input.trim().replace(/\/+$/, '');
  try {
    const { protocol } = new URL(baseUrl);
    if (protocol === 'http:' || protocol === 'https:') return baseUrl;
  } catch { /* Invalid URLs use the same error as unsupported protocols. */ }
  throw new LoginError('unreachable', 'Enter an HTTP or HTTPS backend URL.');
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
  const body = await response.json().catch(() => null);
  if (body?.mfa_required === true || body?.verification_required === true || body?.location !== undefined) {
    throw new LoginError('unsupported_account', 'This account requires an unsupported sign-in flow.');
  }
  if (typeof body?.token !== 'string') throw new LoginError('server_error', 'The backend returned no token.');
  return { baseUrl, email, token: body.token };
}

export async function refreshSession(session: Session, fetchImpl = globalThis.fetch): Promise<Session> {
  let response: Response;
  try {
    response = await fetchImpl(`${session.baseUrl}/auth/token/refresh`, {
      method: 'POST', headers: { Authorization: `Bearer ${session.token}` },
    });
  } catch { throw new LoginError('unreachable', 'Could not reach the backend.'); }
  if (response.status === 401) throw new LoginError('invalid_credentials', 'Please sign in again.');
  if (!response.ok) throw new LoginError('server_error', 'The backend could not refresh the session.');
  const body = await response.json().catch(() => null);
  if (typeof body?.token !== 'string') throw new LoginError('server_error', 'The backend returned no token.');
  return { ...session, token: body.token };
}

export function tokenExpiresAt(token: string): number | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const { exp } = JSON.parse(atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, '=')));
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
    const value = JSON.parse(storage?.getItem(STORAGE_KEY) ?? 'null');
    if (typeof value?.baseUrl !== 'string' || typeof value?.email !== 'string' || typeof value?.token !== 'string') return null;
    return { baseUrl: value.baseUrl, email: value.email, token: value.token };
  } catch { return null; }
}

export function saveSession(storage: SessionStorage | null, session: Session): void {
  try {
    const { baseUrl, email, token } = session;
    storage?.setItem(STORAGE_KEY, JSON.stringify({ baseUrl, email, token }));
  } catch { /* Keep the in-memory session when web storage is unavailable. */ }
}

export function clearSession(storage: SessionStorage | null): void {
  try { storage?.removeItem(STORAGE_KEY); } catch { /* Web storage may be unavailable. */ }
}
