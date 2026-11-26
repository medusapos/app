import { authHeaders } from './pos-connector';
import type { Session } from './session';

// The lowest plugin `pluginContract` (on /tally/v1/info) this app works with. Raise it together with the plugin's
// PLUGIN_CONTRACT (packages/medusa-plugin/src/api/tally/v1/versions.ts) when the app starts depending on something newer.
// 1: Reports' closures rely on the plugin filtering GET /tally/v1/registers/{id}/closures by `cashier` (#446).
export const MIN_PLUGIN_CONTRACT = 1;
// The plugin contract that adds POST /tally/v1/device-clear-approvals (#280); only Clear all local data needs it, so
// MIN_PLUGIN_CONTRACT stays 1 (raising it would lock every store on an older plugin out of the app).
export const DEVICE_CLEAR_PLUGIN_CONTRACT = 2;
// The plugin contract that prices and applies order.refund v1 (ADR 0026 decision 8); only Refund needs it.
export const REFUND_PLUGIN_CONTRACT = 5;
// The plugin contract that adds `region_id` and `terminal` on GET /tally/v1/payment-providers; only Card readers needs it.
export const CARD_READERS_PLUGIN_CONTRACT = 6;

/** `unknown`: the read was inconclusive (offline, a timeout, a non-2xx, not an info body) and never latches. */
export type PluginContractStatus = 'ok' | 'too_old' | 'unknown';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** An info body (it has a `contracts` object) is `ok` at or above the minimum, else `too_old` (a plugin from before the field). */
export function pluginContractStatus(body: unknown): PluginContractStatus {
  if (!isRecord(body) || !isRecord(body.contracts)) return 'unknown';
  const contract = body.pluginContract;
  return typeof contract === 'number' && Number.isSafeInteger(contract) && contract >= MIN_PLUGIN_CONTRACT ? 'ok' : 'too_old';
}

/** One read of the store's /info; never throws. */
export async function readPluginContract(session: Pick<Session, 'baseUrl' | 'token'>, fetchImpl = globalThis.fetch,
  timeoutMs = 5000): Promise<PluginContractStatus> {
  const body = await readInfo(session, fetchImpl, timeoutMs);
  return body === undefined ? 'unknown' : pluginContractStatus(body);
}

/**
 * One read of the store's /info, never throws: an info body's `pluginContract` (0 for a plugin from before the field),
 * or null when the read was inconclusive (offline, a timeout, a non-2xx, not an info body).
 */
export async function readPluginContractVersion(session: Pick<Session, 'baseUrl' | 'token'>, fetchImpl = globalThis.fetch,
  timeoutMs = 5000): Promise<number | null> {
  const body = await readInfo(session, fetchImpl, timeoutMs);
  if (!isRecord(body) || !isRecord(body.contracts)) return null;
  return typeof body.pluginContract === 'number' && Number.isSafeInteger(body.pluginContract) ? body.pluginContract : 0;
}

// The /info body of a 2xx answer, or undefined when the read failed or timed out.
async function readInfo(session: Pick<Session, 'baseUrl' | 'token'>, fetchImpl: typeof fetch, timeoutMs: number): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      fetchImpl(`${session.baseUrl}/tally/v1/info`, { method: 'GET', headers: authHeaders(session.token) }),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
    if (!response || !response.ok) return undefined;
    return await response.json();
  } catch {
    return undefined;
  } finally { clearTimeout(timer); }
}
