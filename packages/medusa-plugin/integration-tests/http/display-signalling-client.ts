import type {
  DisplaySignalling, DisplaySignallingContext, DisplaySignallingErrorCode, SyncContext, TillDevice,
} from '@tallyui/core' with { 'resolution-mode': 'import' }

/**
 * The plugin's `DisplaySignalling` over HTTP: the reference for the connector-medusa client. Till calls send the
 * session's headers and the device in `X-Tally-Device-Id` / `X-Tally-Device-Key`; display calls send the token only in
 * `X-Tally-Display-Token`. A refusal is an error whose `code` is `too_large` for any 400 or 413, else the body's code when
 * the seam names it, else `forbidden` for a codeless 401 or 403 (Medusa's session and policy refusals), else `server`.
 */
const SEAM_CODES: DisplaySignallingErrorCode[] = ['forbidden', 'limit', 'claim_refused', 'collect_refused', 'not_found',
  'device_refused', 'token_refused', 'too_large', 'network', 'server']

/** Core's `DisplaySignallingError` is in its ESM root, which this CommonJS suite cannot load; same shape. */
export class DisplaySignallingClientError extends Error {
  constructor(readonly code: DisplaySignallingErrorCode, message?: string) {
    super(message ?? code)
    this.name = 'DisplaySignallingError'
  }
}

type Context = { baseUrl: string; fetch?: typeof globalThis.fetch; headers?: Record<string, string> }

async function call<T>(ctx: Context, method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<T> {
  let response: Response
  try {
    response = await (ctx.fetch ?? globalThis.fetch)(`${ctx.baseUrl}${path}`, {
      method,
      headers: { ...ctx.headers, ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  } catch {
    throw new DisplaySignallingClientError('network')
  }
  if (response.status === 204) return undefined as T
  const answer = await response.json().catch(() => ({})) as { code?: unknown; message?: unknown }
  if (response.ok) return answer as T
  // Every 400 and 413 (a malformed body, or the parser's own limit) is too_large, which pos does not retry (ADR-085).
  // Medusa's own refusals carry no seam code: its 401 (no or expired session) and its policy 403 (no tally_pos:use)
  // are both `forbidden`. Every refusal the plugin gives itself names its code.
  const seamCode = SEAM_CODES.find(known => known === answer.code)
  const code = response.status === 400 || response.status === 413 ? 'too_large'
    : seamCode ?? (response.status === 401 || response.status === 403 ? 'forbidden' : 'server')
  throw new DisplaySignallingClientError(code, typeof answer.message === 'string' ? answer.message : undefined)
}

const device = (d: TillDevice) => ({ 'X-Tally-Device-Id': d.deviceId, 'X-Tally-Device-Key': d.deviceKey })
const token = (t: string) => ({ 'X-Tally-Display-Token': t })
const at = encodeURIComponent

export function createHttpDisplaySignalling(): DisplaySignalling {
  const till = <T>(ctx: SyncContext, d: TillDevice, method: string, path: string, body?: unknown) =>
    call<T>(ctx, method, path, device(d), body)
  const display = <T>(dctx: DisplaySignallingContext, t: string, method: string, path: string, body?: unknown) =>
    call<T>(dctx, method, path, token(t), body)
  return {
    registerDevice: (ctx, deviceId) => call(ctx, 'POST', '/tally/v1/display-devices', {}, { deviceId }),
    mint: (ctx, d) => till(ctx, d, 'POST', '/tally/v1/display-codes'),
    pending: async (ctx, d) => (await till<{ pairings: any[] }>(ctx, d, 'GET', '/tally/v1/display-pairings')).pairings,
    confirm: (ctx, d, claimId) => till(ctx, d, 'POST', `/tally/v1/display-pairings/${at(claimId)}/confirm`),
    decline: (ctx, d, claimId) => till(ctx, d, 'POST', `/tally/v1/display-pairings/${at(claimId)}/decline`),
    list: async (ctx, d) => (await till<{ displays: any[] }>(ctx, d, 'GET', '/tally/v1/displays')).displays,
    forget: (ctx, d, displayId) => till(ctx, d, 'DELETE', `/tally/v1/displays/${at(displayId)}`),
    sendSignal: (ctx, d, displayId, message) => till(ctx, d, 'POST', `/tally/v1/displays/${at(displayId)}/signals`, message),
    receiveSignals: async (ctx, d) => (await till<{ signals: any[] }>(ctx, d, 'POST', '/tally/v1/display-signals/drain')).signals,
    postSnapshot: (ctx, d, displayId, body) => till(ctx, d, 'PUT', `/tally/v1/displays/${at(displayId)}/snapshot`, { snapshot: body ?? null }),
    claim: (dctx, request) => call(dctx, 'POST', '/tally/v1/display/claim', {}, request),
    collect: (dctx, claimSecret) => call(dctx, 'POST', '/tally/v1/display/collect', {}, { claimSecret }),
    displaySendSignal: (dctx, t, message) => display(dctx, t, 'POST', '/tally/v1/display/signals', message),
    displayReceiveSignals: async (dctx, t) =>
      (await display<{ signals: any[] }>(dctx, t, 'POST', '/tally/v1/display/signals/drain')).signals,
    readSnapshot: async (dctx, t) => (await display<{ snapshot: unknown }>(dctx, t, 'GET', '/tally/v1/display/snapshot')).snapshot,
  }
}
