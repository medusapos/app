import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { MedusaContainer } from '@medusajs/framework/types'
import { ContainerRegistrationKeys, FeatureFlag, Modules } from '@medusajs/framework/utils'
import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import tallyPosRoles from '../../src/scripts/tally-pos-roles'

jest.setTimeout(180000)

// Register RBAC before the test runner evaluates medusa-config.
FeatureFlag.setFlag('rbac', true)

const forbidden = { code: 'approval_forbidden', message: "This user can't approve clearing this device." }

medusaIntegrationTestRunner({
  cwd: path.resolve(__dirname, '../plugin-app'),
  env: { MEDUSA_FF_RBAC: 'true' },
  testSuite: ({ api, getContainer }) => {
    let container: MedusaContainer
    let headers: Record<string, string>

    async function roleId(name: string) {
      return (await container.resolve(Modules.RBAC).listRbacRoles({ name }))[0].id
    }
    async function makeUser(role?: string, names = {}) {
      const email = `device-clear-${randomUUID()}@example.com`
      const password = 'integration-test-password'
      const user = await container.resolve(Modules.USER).createUsers({ email, ...names })
      const auth = container.resolve(Modules.AUTH)
      const { authIdentity, error } = await auth.register('emailpass', { body: { email, password } })
      expect(error).toBeUndefined()
      await auth.updateAuthIdentities({ id: authIdentity!.id, app_metadata: { user_id: user.id } })
      if (role) await container.resolve(ContainerRegistrationKeys.LINK).create({
        [Modules.USER]: { user_id: user.id }, [Modules.RBAC]: { rbac_role_id: role },
      })
      return { user, email, password }
    }
    async function requester(role?: string) {
      const { email, password } = await makeUser(role)
      const login = await api.post('/auth/user/emailpass', { email, password })
      expect(login.status).toBe(200)
      return { Authorization: `Bearer ${login.data.token}`, 'X-Tally-Protocol': '1' }
    }
    function approve(body: Record<string, unknown>, actorHeaders = headers) {
      return api.post('/tally/v1/device-clear-approvals', body, { headers: actorHeaders, validateStatus: () => true })
    }
    beforeEach(async () => {
      container = getContainer()
      await tallyPosRoles({ container, args: [] })
      headers = await requester(await roleId('POS cashier'))
    })

    it('a POS manager approves without a token or cookie, expiring in 15 minutes', async () => {
      const manager = await makeUser(await roleId('POS manager'), { first_name: 'Ada', last_name: 'Lovelace' })
      const before = Date.now()
      const response = await approve({ email: manager.email, password: manager.password })
      expect(response.status).toBe(200)
      expect(response.data).toEqual({ approvedBy: manager.user.id, approvedByName: 'Ada Lovelace', expiresAt: expect.any(String) })
      expect(response.headers['set-cookie']).toBeUndefined()
      expect(Date.parse(response.data.expiresAt)).toBeGreaterThanOrEqual(before + 15 * 60 * 1000 - 1000)
      expect(Date.parse(response.data.expiresAt)).toBeLessThanOrEqual(Date.now() + 15 * 60 * 1000 + 1000)
    })

    it('role_super_admin approves, named by email when it has no names', async () => {
      const admin = await makeUser('role_super_admin')
      const response = await approve({ email: admin.email, password: admin.password })
      expect(response.status).toBe(200)
      expect(response.data.approvedByName).toBe(admin.email)
    })

    it('uses the same credential error for a wrong password and an unknown email', async () => {
      const manager = await makeUser(await roleId('POS manager'))
      const wrong = await approve({ email: manager.email, password: 'wrong-password' })
      const unknown = await approve({ email: `${randomUUID()}@example.com`, password: manager.password })
      expect([wrong.status, unknown.status]).toEqual([401, 401])
      expect(wrong.data).toEqual({ code: 'approval_invalid_credentials', message: "The manager's email or password is not correct." })
      expect(unknown.data).toEqual(wrong.data)
    })

    it('refuses a role with variance approval but not tally_pos:clear_device', async () => {
      const rbac = container.resolve(Modules.RBAC)
      const [role] = await rbac.createRbacRoles([{ name: `Variance approver ${randomUUID()}` }])
      const policies = await rbac.listRbacPolicies({ key: ['tally_pos:use', 'tally_pos:approve_variance'] })
      expect(policies).toHaveLength(2)
      await rbac.createRbacRolePolicies(policies.map(policy => ({ role_id: role.id, policy_id: policy.id })))
      const approver = await makeUser(role.id)
      const response = await approve({ email: approver.email, password: approver.password })
      expect(response.status).toBe(403)
      expect(response.data).toEqual(forbidden)
    })

    it('refuses a POS cashier as approver', async () => {
      const approver = await makeUser(await roleId('POS cashier'))
      const response = await approve({ email: approver.email, password: approver.password })
      expect(response.status).toBe(403)
      expect(response.data).toEqual(forbidden)
    })

    it('limits a requester after five failures, even with a correct password, and serves another requester', async () => {
      const manager = await makeUser(await roleId('POS manager'))
      for (let i = 0; i < 5; i++) expect((await approve({ email: manager.email, password: 'wrong-password' })).status).toBe(401)
      const response = await approve({ email: manager.email, password: manager.password })
      expect(response.status).toBe(429)
      expect(response.data).toEqual({ code: 'approval_rate_limited', message: 'Too many failed approvals. Try again in a few minutes.' })
      const other = await requester(await roleId('POS cashier'))
      expect((await approve({ email: manager.email, password: manager.password }, other)).status).toBe(200)
    })

    it('rejects a missing password', async () => {
      const manager = await makeUser(await roleId('POS manager'))
      const response = await approve({ email: manager.email })
      expect(response.status).toBe(400)
      expect(response.data).toEqual({ code: 'invalid_payload', message: 'password: expected a non-empty string' })
    })

    it('requires a token and tally_pos:use', async () => {
      const manager = await makeUser(await roleId('POS manager'))
      const body = { email: manager.email, password: manager.password }
      expect((await approve(body, { 'X-Tally-Protocol': '1' })).status).toBe(401)
      const response = await approve(body, await requester())
      expect(response.status).toBe(403)
      expect(response.data).toMatchObject({ type: 'forbidden', message: 'Forbidden' })
    })
  },
})
