import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { MedusaContainer } from '@medusajs/framework/types'
import { ContainerRegistrationKeys, FeatureFlag, Modules } from '@medusajs/framework/utils'
import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import tallyPosRoles, { POS_CASHIER_POLICIES, POS_MANAGER_POLICIES } from '../../src/scripts/tally-pos-roles'

jest.setTimeout(180000)

// Register RBAC before the test runner evaluates medusa-config.
FeatureFlag.setFlag('rbac', true)

medusaIntegrationTestRunner({
  cwd: path.resolve(__dirname, '../plugin-app'),
  env: { MEDUSA_FF_RBAC: 'true' },
  testSuite: ({ api, getContainer }) => {
    let container: MedusaContainer
    beforeAll(() => { container = getContainer() })

    async function loginWithRoles(roleIds: string[]) {
      const email = `pos-${randomUUID()}@example.com`
      const password = 'integration-test-password'
      const user = await container.resolve(Modules.USER).createUsers({ email })
      const auth = container.resolve(Modules.AUTH)
      const { authIdentity, error } = await auth.register('emailpass', { body: { email, password } })
      expect(error).toBeUndefined()
      await auth.updateAuthIdentities({ id: authIdentity!.id, app_metadata: { user_id: user.id } })
      for (const roleId of roleIds) {
        await container.resolve(ContainerRegistrationKeys.LINK).create({
          [Modules.USER]: { user_id: user.id },
          [Modules.RBAC]: { rbac_role_id: roleId },
        })
      }
      const login = await api.post('/auth/user/emailpass', { email, password })
      expect(login.status).toBe(200)
      return { Authorization: `Bearer ${login.data.token}`, 'X-Tally-Protocol': '1' }
    }

    it('no token: /tally/v1/info is 401, not 403', async () => {
      const response = await api.get('/tally/v1/info', {
        headers: { 'X-Tally-Protocol': '1' }, validateStatus: () => true,
      })
      expect(response.status).toBe(401)
    })

    it('a user with no roles is refused 403 on every /tally/v1 route', async () => {
      const headers = await loginWithRoles([])
      for (const url of [
        '/tally/v1/info', '/tally/v1/registers/reg_x', '/tally/v1/changes', '/tally/v1/changes/tick',
      ]) {
        const response = await api.get(url, { headers, validateStatus: () => true })
        expect(response.status).toBe(403)
        expect(response.data).toMatchObject({ type: 'forbidden', message: 'Forbidden' })
      }
      const response = await api.post('/tally/v1/commands', { commands: [] }, { headers, validateStatus: () => true })
      expect(response.status).toBe(403)
      expect(response.data).toMatchObject({ type: 'forbidden', message: 'Forbidden' })
    })

    it('role_super_admin may use the POS', async () => {
      const headers = await loginWithRoles(['role_super_admin'])
      const response = await api.get('/tally/v1/info', { headers })
      expect(response.status).toBe(200)
      expect(response.data.contracts).toEqual(expect.any(Object))
    })

    it('tally-pos-roles creates POS cashier and POS manager once, with their policies', async () => {
      const exitCode = process.exitCode
      try {
        await tallyPosRoles({ container, args: [] })
        await tallyPosRoles({ container, args: [] })
        const rbac = container.resolve(Modules.RBAC)
        for (const { name, keys } of [
          { name: 'POS cashier', keys: POS_CASHIER_POLICIES },
          { name: 'POS manager', keys: POS_MANAGER_POLICIES },
        ]) {
          const roles = await rbac.listRbacRoles({ name })
          expect(roles).toHaveLength(1)
          const links = await rbac.listRbacRolePolicies({ role_id: roles[0].id })
          const policies = await rbac.listRbacPolicies({ id: links.map(link => link.policy_id) })
          expect(new Set(policies.map(policy => policy.key))).toEqual(new Set(keys))
          expect(links).toHaveLength(keys.length)
        }
        expect(process.exitCode).not.toBe(1)
      } finally {
        process.exitCode = exitCode
      }
    })

    it('a POS cashier may use /tally/v1 and read products, and is refused /admin/orders', async () => {
      await tallyPosRoles({ container, args: [] })
      const [role] = await container.resolve(Modules.RBAC).listRbacRoles({ name: 'POS cashier' })
      const headers = await loginWithRoles([role.id])
      for (const url of [
        '/tally/v1/info', '/tally/v1/changes/tick', '/admin/products?limit=1', '/admin/users/me',
      ]) {
        const response = await api.get(url, { headers })
        expect(response.status).toBe(200)
      }
      const response = await api.get('/admin/orders?limit=1', { headers, validateStatus: () => true })
      expect(response.status).toBe(403)
    })

    it('a POS manager may use /tally/v1', async () => {
      await tallyPosRoles({ container, args: [] })
      const [role] = await container.resolve(Modules.RBAC).listRbacRoles({ name: 'POS manager' })
      const headers = await loginWithRoles([role.id])
      const response = await api.get('/tally/v1/info', { headers })
      expect(response.status).toBe(200)
    })

    it('a role without tally_pos:use is refused 403 with the policy named', async () => {
      const rbac = container.resolve(Modules.RBAC)
      const [role] = await rbac.createRbacRoles([{ name: 'Product reader' }])
      const [policy] = await rbac.listRbacPolicies({ key: ['product:read'] })
      await rbac.createRbacRolePolicies([{ role_id: role.id, policy_id: policy.id }])
      const headers = await loginWithRoles([role.id])
      const response = await api.get('/tally/v1/info', { headers, validateStatus: () => true })
      expect(response.status).toBe(403)
      expect(response.data.type).toBe('forbidden')
      expect(response.data.message).toContain('tally_pos:use')
    })

    it.each([
      ['POS manager', 200], ['POS cashier', 403], ['no roles', 403], ['role_super_admin', 200],
    ])('a POS cashier requests approval from %s: %i', async (roleName, status) => {
      await tallyPosRoles({ container, args: [] })
      const rbac = container.resolve(Modules.RBAC)
      const [cashierRole] = await rbac.listRbacRoles({ name: 'POS cashier' })
      const headers = await loginWithRoles([cashierRole.id])
      const email = `approver-${randomUUID()}@example.com`
      const password = 'integration-test-password'
      const user = await container.resolve(Modules.USER).createUsers({ email })
      const auth = container.resolve(Modules.AUTH)
      const { authIdentity, error } = await auth.register('emailpass', { body: { email, password } })
      expect(error).toBeUndefined()
      await auth.updateAuthIdentities({ id: authIdentity!.id, app_metadata: { user_id: user.id } })
      if (roleName !== 'no roles') {
        const roleId = roleName === 'role_super_admin' ? roleName : (await rbac.listRbacRoles({ name: roleName }))[0].id
        await container.resolve(ContainerRegistrationKeys.LINK).create({
          [Modules.USER]: { user_id: user.id }, [Modules.RBAC]: { rbac_role_id: roleId },
        })
      }
      const sessionId = randomUUID()
      const openedAt = '2026-01-01T08:00:00.000Z'
      const opening = await api.post('/tally/v1/commands', { commands: [{
        id: randomUUID(), type: 'register.session.open', version: 1, createdAt: openedAt, deviceId: randomUUID(), attempt: 1,
        payload: { sessionId, registerId: randomUUID(), openedAt, countedFloatMinor: 100 },
      }] }, { headers })
      expect(opening.data.results[0].status).toBe('applied')
      const response = await api.post('/tally/v1/register-approvals', {
        sessionId, variance: { cash: -20 }, email, password,
      }, { headers, validateStatus: () => true })
      expect(response.status).toBe(status)
      if (status === 200) expect(response.data).toMatchObject({
        approval: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), approvedBy: user.id, approvedByName: email,
      })
      else expect(response.data).toEqual({ code: 'approval_forbidden', message: "This user can't approve register variances." })
    })
  },
})
