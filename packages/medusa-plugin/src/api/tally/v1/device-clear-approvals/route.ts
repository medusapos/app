import { hasPermission } from '@medusajs/framework'
import type { IFlagRouter } from '@medusajs/framework/feature-flags'
import type { AuthenticatedMedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import { APPROVAL_TTL_MS } from '../../../../modules/tally-register/service'
import { deviceClearAttempts } from './attempts'

// The device wipes its own local data, so this approval guards against accidents; it is not a security boundary.
// With RBAC off every admin user counts as a manager.
export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const { email, password } = (req.body ?? {}) as Record<string, unknown>
  const errors: string[] = []
  const check = (valid: boolean, field: string, what: string) => {
    if (!valid) errors.push(`${field}: expected ${what}`)
  }
  for (const [field, value] of Object.entries({ email, password }))
    check(typeof value === 'string' && value.length > 0, field, 'a non-empty string')
  if (errors.length) return res.status(400).json({ code: 'invalid_payload', message: errors.join('; ') })

  const attempt = deviceClearAttempts.admit(req.auth_context.actor_id, email as string)
  if (!attempt) return res.status(429).json({ code: 'approval_rate_limited',
    message: 'Too many failed approvals. Try again in a few minutes.' })
  const { success, authIdentity, mfaChallenge } = await req.scope.resolve(Modules.AUTH)
    .authenticate('emailpass', { body: { email: email as string, password: password as string } })
  if (mfaChallenge) return res.status(401).json({ code: 'approval_mfa_unsupported',
    message: "This manager's login needs a second step, which the POS can't do yet." })
  if (!success || !authIdentity) return res.status(401).json({ code: 'approval_invalid_credentials',
    message: "The manager's email or password is not correct." })
  const userId = authIdentity.app_metadata?.user_id
  let allowed = typeof userId === 'string' && userId.length > 0
  if (allowed && req.scope.resolve<IFlagRouter>(ContainerRegistrationKeys.FEATURE_FLAG_ROUTER).isFeatureEnabled('rbac')) {
    const { data } = await req.scope.resolve(ContainerRegistrationKeys.QUERY).graph({
      entity: 'user', fields: ['rbac_roles.id'], filters: { id: userId },
    })
    const roles = data[0]?.rbac_roles?.map(role => role.id) ?? []
    allowed = roles.length > 0 && await hasPermission({ roles,
      actions: { resource: 'tally_pos', operation: 'clear_device' }, container: req.scope })
  }
  if (!allowed) return res.status(403).json({ code: 'approval_forbidden', message: "This user can't approve clearing this device." })
  const user = await req.scope.resolve(Modules.USER).retrieveUser(userId as string)
  const approvedByName = user.first_name || user.last_name
    ? `${user.first_name ?? ''} ${user.last_name ?? ''}`.trim() : user.email
  attempt.succeed()
  return res.status(200).json({ approvedBy: userId, approvedByName,
    expiresAt: new Date(Date.now() + APPROVAL_TTL_MS).toISOString() })
}
