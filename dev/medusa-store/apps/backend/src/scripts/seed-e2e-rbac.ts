import type { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { createUsersWorkflow } from "@medusajs/medusa/core-flows"

// The RBAC e2e users (e2e/rbac), after tally-pos-roles. Not `medusa user`, which links
// role_super_admin while the flag is on; these are its user and identity steps with our own roles.
const USERS = [
  { email: "pos-cashier@tally.test", password: "e2e-password", role: "POS cashier" },
  { email: "no-pos@tally.test", password: "e2e-password", role: null },
]

export default async function seedE2eRbac({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const rbac = container.resolve(Modules.RBAC)
  const auth = container.resolve(Modules.AUTH)
  for (const { email, password, role } of USERS) {
    const roles = role ? (await rbac.listRbacRoles({ name: role })).map(({ id }) => id) : []
    if (role && !roles.length) throw new Error(`seed-e2e-rbac: no "${role}" role; run tally-pos-roles first`)
    const { result: [user] } = await createUsersWorkflow(container).run({ input: { users: [{ email, roles }] } })
    const { authIdentity, error } = await auth.register("emailpass", { body: { email, password } })
    if (error || !authIdentity) throw new Error(`seed-e2e-rbac: ${email}: ${error}`)
    await auth.updateAuthIdentities({ id: authIdentity.id, app_metadata: { user_id: user.id } })
    logger.info(`seed-e2e-rbac: ${email} created with ${role ?? "no"} role`)
  }
}
