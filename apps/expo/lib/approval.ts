import { authHeaders } from './pos-connector';
import { login, LoginError, type SessionStorage } from './session';

/**
 * A close over this count variance, in minor units, needs a manager's approval (ADR 0018): €5.00 for the EUR
 * stores the app serves today. A constant until it becomes a per-store setting.
 */
export const VARIANCE_THRESHOLD_MINOR = 500;

export type Approval = { approvedBy: string; approvedByName: string };
export class ApprovalError extends Error {
  constructor(readonly code: 'invalid' | 'offline' | 'failed', message: string) { super(message); }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * A second Medusa admin login for a close over the threshold (ADR 0018, option b): signs in with the approver's
 * email and password without saving or replacing the cashier's session, reads `/admin/users/me` with that token,
 * then drops the token. Nothing here stores, logs or returns the password or the token.
 */
export async function requestApproval(baseUrl: string, email: string, password: string, fetchImpl = globalThis.fetch): Promise<Approval> {
  let token: string;
  try {
    ({ token } = await login(baseUrl, email, password, fetchImpl));
  } catch (error) {
    if (error instanceof LoginError && error.code === 'unreachable') throw new ApprovalError('offline', error.message);
    if (error instanceof LoginError && (error.code === 'invalid_credentials' || error.code === 'unsupported_account')) {
      throw new ApprovalError('invalid', "That email and password didn't work.");
    }
    if (error instanceof TypeError) throw new ApprovalError('offline', 'Could not reach the backend.');
    throw new ApprovalError('failed', error instanceof LoginError ? error.message : "Couldn't check the approval. Try again.");
  }
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl.trim().replace(/\/+$/, '')}/admin/users/me`, { method: 'GET', headers: authHeaders(token) });
  } catch { throw new ApprovalError('offline', 'Could not reach the backend.'); }
  const body: unknown = response.ok ? await response.json().catch(() => null) : null;
  const user = isRecord(body) && isRecord(body.user) ? body.user : null;
  if (!user || typeof user.id !== 'string' || !user.id) throw new ApprovalError('failed', "Couldn't check the approval. Try again.");
  const name = [user.first_name, user.last_name].filter((part) => typeof part === 'string').join(' ').trim();
  return { approvedBy: user.id, approvedByName: name || (typeof user.email === 'string' && user.email ? user.email : email) };
}

// Approvers' names by user id, per backend (like ADR 0016's device settings): a close resumed after a restart has
// no approver name on its session, so the closure's name comes from here. Ids and names only, never a credential.
const PREFIX = 'medusapos.approvers.';
// Plenty for a store's managers; the oldest entries go first.
const MAX_APPROVERS = 50;

export function loadApprovers(storage: SessionStorage | null, baseUrl: string): Record<string, string> {
  try {
    const value: unknown = JSON.parse(storage?.getItem(PREFIX + baseUrl) ?? 'null');
    if (!isRecord(value) || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } catch { return {}; }
}

export function rememberApprover(storage: SessionStorage | null, baseUrl: string, id: string, name: string): void {
  const others = Object.entries(loadApprovers(storage, baseUrl)).filter(([key]) => key !== id);
  const next = Object.fromEntries([...others, [id, name]].slice(-MAX_APPROVERS));
  try { storage?.setItem(PREFIX + baseUrl, JSON.stringify(next)); } catch { /* The name then falls back to the id. */ }
}
