import { createHash, randomBytes } from 'node:crypto'
import { hasPermission } from '@medusajs/framework'
import type { IFlagRouter } from '@medusajs/framework/feature-flags'
import type { AuthenticatedMedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import { TALLY_REGISTER_MODULE } from '../../../../modules/tally-register'
import type TallyRegisterModuleService from '../../../../modules/tally-register/service'

export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const { sessionId, variance, email, password } = (req.body ?? {}) as Record<string, unknown>
  const errors: string[] = []
  const check = (valid: boolean, field: string, what: string) => {
    if (!valid) errors.push(`${field}: expected ${what}`)
  }
  check(typeof sessionId === 'string' && sessionId.length > 0 && sessionId.length <= 64,
    'sessionId', 'a non-empty string of at most 64 characters')
  const plain = typeof variance === 'object' && variance !== null &&
    (Object.getPrototypeOf(variance) === Object.prototype || Object.getPrototypeOf(variance) === null)
  check(plain, 'variance', 'an object')
  if (plain) for (const [key, value] of Object.entries(variance)) {
    check(key === 'cash' || key === 'external', `variance.${key}`, 'a payment method (cash or external)')
    check(Number.isSafeInteger(value), `variance.${key}`, 'a safe integer')
  }
  for (const [field, value] of Object.entries({ email, password }))
    check(typeof value === 'string' && value.length > 0, field, 'a non-empty string')
  if (errors.length) return res.status(400).json({ code: 'invalid_payload', message: errors.join('; ') })

  const service = req.scope.resolve<TallyRegisterModuleService>(TALLY_REGISTER_MODULE)
  const admitted = await service.admitApproval({ sessionId: sessionId as string, variance: variance as Record<string, number>,
    requestedBy: req.auth_context.actor_id, email: email as string })
  if (admitted.kind === 'refused') {
    const messages = {
      approval_session_unknown: 'This register session is not known to the store.',
      approval_session_closed: 'This register session is already closed.',
      approval_rate_limited: 'Too many failed approvals. Try again in a few minutes.',
    }
    return res.status(admitted.code === 'approval_rate_limited' ? 429 : 409)
      .json({ code: admitted.code, message: messages[admitted.code] })
  }
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
      actions: { resource: 'tally_pos', operation: 'approve_variance' }, container: req.scope })
  }
  if (!allowed) return res.status(403).json({ code: 'approval_forbidden', message: "This user can't approve register variances." })
  const user = await req.scope.resolve(Modules.USER).retrieveUser(userId as string)
  const approvedByName = user.first_name || user.last_name
    ? `${user.first_name ?? ''} ${user.last_name ?? ''}`.trim() : user.email
  const proof = randomBytes(32).toString('base64url')
  const { expiresAt } = await service.issueApproval(admitted.id, {
    tokenHash: createHash('sha256').update(proof).digest('hex'), approvedBy: userId as string, approvedByName,
  })
  return res.status(200).json({ approval: proof, approvedBy: userId, approvedByName, expiresAt })
}
