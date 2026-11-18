import { authHeaders } from './pos-connector';
import type { Session } from './session';

// The lowest plugin `pluginContract` (on /tally/v1/info) this app works with. Raise it together with the plugin's
// PLUGIN_CONTRACT (packages/medusa-plugin/src/api/tally/v1/versions.ts) when the app starts depending on something newer.
// 1: Reports' closures rely on the plugin filtering GET /tally/v1/registers/{id}/closures by `cashier` (#446).
export const MIN_PLUGIN_CONTRACT = 1;

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
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      fetchImpl(`${session.baseUrl}/tally/v1/info`, { method: 'GET', headers: authHeaders(session.token) }),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
    if (!response || !response.ok) return 'unknown';
    return pluginContractStatus(await response.json());
  } catch {
    return 'unknown';
  } finally { clearTimeout(timer); }
}
