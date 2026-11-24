import { hasPermission } from '@medusajs/framework'
import type { IFlagRouter } from '@medusajs/framework/feature-flags'
import type { MedusaContainer } from '@medusajs/framework/types'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'

/**
 * The closure-approval manager check (ADR 0023), shared by register approvals and refunds (ADR 0026 decision 7):
 * with RBAC on, the user's roles must grant tally_pos:approve_variance, read live; with RBAC off, any user counts.
 */
export async function mayApproveVariance(container: MedusaContainer, userId: unknown): Promise<boolean> {
  if (typeof userId !== 'string' || userId.length === 0) return false
  if (!container.resolve<IFlagRouter>(ContainerRegistrationKeys.FEATURE_FLAG_ROUTER).isFeatureEnabled('rbac')) return true
  const { data } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({
    entity: 'user', fields: ['rbac_roles.id'], filters: { id: userId },
  })
  const roles = data[0]?.rbac_roles?.map(role => role.id) ?? []
  return roles.length > 0 && await hasPermission({ roles,
    actions: { resource: 'tally_pos', operation: 'approve_variance' }, container })
}
