import { hasPermission } from '@medusajs/framework'
import type { IFlagRouter } from '@medusajs/framework/feature-flags'
import type { AuthenticatedMedusaRequest, MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { TALLY_DISPLAY_MODULE } from '../../../modules/tally-display'
import { DisplayRefusal, type DisplayRefusalCode } from '../../../modules/tally-display/refusal'
import type TallyDisplayModuleService from '../../../modules/tally-display/service'
import type { SignalMessage, TillDevice } from '../../../modules/tally-display/service'

// One fixed message per code, so two refusals with one code are indistinguishable, and none carries a key, token,
// secret, code or hash (ADR-085 d4, #705). None is 401: pos reads a codeless 401 as Medusa's own session refusal.
const REFUSALS: Record<DisplayRefusalCode, [status: number, message: string]> = {
  forbidden: [403, 'This user cannot pair customer displays.'],
  device_refused: [403, 'This till device is not recognised.'],
  token_refused: [403, 'This display is not paired with the store.'],
  not_found: [404, 'Not found on this till device.'],
  limit: [429, 'This till device already holds 5 unused pairing codes.'],
  rate_limited: [429, 'Too many refused display requests from this address. Try again in a minute.'],
  claim_refused: [403, 'The pairing code was not accepted.'],
  collect_refused: [403, 'This pairing cannot be collected.'],
  too_large: [413, 'The snapshot is over 204800 bytes.'],
}

/** A malformed body: 400 with the seam's `server` code, as the connector maps an answer the seam does not name. */
class Malformed extends Error {}

/** Runs one call and answers its result with `status` (204 when it gives nothing), or its refusal. */
export async function answered(res: MedusaResponse, status: number, work: () => Promise<unknown>): Promise<void> {
  try {
    const body = await work()
    if (body === undefined) res.sendStatus(204)
    else res.status(status).json(body)
  } catch (error) {
    if (error instanceof Malformed) res.status(400).json({ code: 'server', message: error.message })
    else if (error instanceof DisplayRefusal) {
      const [refusedWith, message] = REFUSALS[error.code]
      res.status(refusedWith).json({ code: error.code, message })
    } else throw error
  }
}

const service = (req: MedusaRequest): TallyDisplayModuleService => req.scope.resolve(TALLY_DISPLAY_MODULE)

/** The body's fields; a body that is not a JSON object is malformed. */
export function fields(req: MedusaRequest): Record<string, unknown> {
  const body = req.body
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Malformed('The body must be a JSON object.')
  return body as Record<string, unknown>
}

/** A string field of 1 to `max` characters, or `undefined` when `optional` and absent. */
export function text(value: unknown, field: string, max: number): string
export function text(value: unknown, field: string, max: number, optional: true): string | undefined
export function text(value: unknown, field: string, max: number, optional = false): string | undefined {
  if (optional && value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0 || value.length > max) throw new Malformed(`${field}: expected a string of 1 to ${max} characters.`)
  return value
}

/** A WebRTC signalling message; the payload is opaque to the store, capped at 64 KiB of text. */
export function signal(req: MedusaRequest): SignalMessage {
  const { type, payload } = fields(req)
  if (type !== 'offer' && type !== 'answer' && type !== 'ice') throw new Malformed('type: expected offer, answer or ice.')
  if (typeof payload !== 'string' || payload.length > 65_536) throw new Malformed('payload: expected a string of at most 65536 characters.')
  return { type, payload }
}

/** The snapshot field of `{ snapshot }`; a body without it is malformed. */
export function snapshot(req: MedusaRequest): unknown {
  const body = fields(req)
  if (!('snapshot' in body)) throw new Malformed('snapshot: expected a field holding any JSON value.')
  return body.snapshot
}

/**
 * The till side's gate: `customer_display.pair`, which is the `tally_pos:pair_display` policy (the user already passed
 * `TALLY_POS_USE` in the middleware). With RBAC off, every POS user holds it, as `approve_variance` does.
 */
export async function tillSide(req: AuthenticatedMedusaRequest) {
  const cashierId = req.auth_context.actor_id
  let allowed = true
  if (req.scope.resolve<IFlagRouter>(ContainerRegistrationKeys.FEATURE_FLAG_ROUTER).isFeatureEnabled('rbac')) {
    const { data } = await req.scope.resolve(ContainerRegistrationKeys.QUERY).graph({
      entity: 'user', fields: ['rbac_roles.id'], filters: { id: cashierId },
    })
    const roles = data[0]?.rbac_roles?.map(role => role.id) ?? []
    allowed = roles.length > 0 && await hasPermission({ roles,
      actions: { resource: 'tally_pos', operation: 'pair_display' }, container: req.scope })
  }
  if (!allowed) throw new DisplayRefusal('forbidden')
  // A missing header is an empty key, which no device holds.
  const device: TillDevice = { deviceId: req.get('x-tally-device-id') ?? '', deviceKey: req.get('x-tally-device-key') ?? '' }
  return { service: service(req), cashierId, device }
}

/** The display side: no login; the token travels only in its header, and the per-source limit reads Express's `req.ip`. */
export function displaySide(req: MedusaRequest) {
  return { service: service(req), token: req.get('x-tally-display-token') ?? '', source: req.ip ?? '' }
}
