import type { ExecArgs, Logger } from '@medusajs/framework/types'
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'

// App and TallyUI connector: /admin/products, /admin/product-variants, /admin/inventory-items,
// /admin/stores, /admin/sales-channels/:id with stock locations, /admin/regions,
// /admin/price-preferences, /admin/tax-regions, /admin/api-keys?type=publishable,
// /admin/users/me, and /admin/customers (read and create).
export const POS_CASHIER_POLICIES = [
  'tally_pos:use',
  'product:read',
  'product_variant:read',
  'inventory_item:read',
  'inventory_level:read',
  'stock_location:read',
  'store:read',
  'sales_channel:read',
  'region:read',
  'price_preference:read',
  'tax_region:read',
  'api_key:read',
  'user:read',
  'customer:read',
  'customer:create',
]

// A flat list of cashier policies plus variance approval; no role inheritance.
export const POS_MANAGER_POLICIES = [...POS_CASHIER_POLICIES, 'tally_pos:approve_variance']

export default async function tallyPosRoles({ container }: ExecArgs) {
  const logger = container.resolve<Logger>(ContainerRegistrationKeys.LOGGER)
  if (!container.hasRegistration(Modules.RBAC)) {
    logger.info("tally_pos roles: RBAC is off (set MEDUSA_FF_RBAC=true and add { resolve: '@medusajs/medusa/rbac' } to modules in medusa-config), nothing to do")
    return
  }
  try {
    const rbac = container.resolve(Modules.RBAC)
    for (const { name, description, keys } of [
      { name: 'POS cashier', description: 'Use the POS and access its catalogue and customers', keys: POS_CASHIER_POLICIES },
      { name: 'POS manager', description: 'Use the POS and approve register close variances', keys: POS_MANAGER_POLICIES },
    ]) {
      const [existing] = await rbac.listRbacRoles({ name })
      const role = existing ?? (await rbac.createRbacRoles([{ name, description }]))[0]
      const state = existing ? 'existing' : 'created'
      const policies = await rbac.listRbacPolicies({ key: keys })
      const found = new Set(policies.map(policy => policy.key))
      const missing = keys.filter(key => !found.has(key))
      if (missing.length) {
        logger.error(`tally_pos roles: ${name} ${state}, 0 policies added; missing policies: ${missing.join(', ')}`)
        process.exitCode = 1
        continue
      }
      const links = await rbac.listRbacRolePolicies({ role_id: role.id })
      const linked = new Set(links.map(link => link.policy_id))
      const additions = policies.filter(policy => !linked.has(policy.id))
      if (additions.length) {
        await rbac.createRbacRolePolicies(additions.map(policy => ({ role_id: role.id, policy_id: policy.id })))
      }
      logger.info(`tally_pos roles: ${name} ${state}, ${additions.length} policies added`)
    }
  } catch (error) {
    logger.error(`tally_pos roles: failed: ${error}`)
    process.exitCode = 1
  }
}
