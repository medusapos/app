import path from 'node:path'
import type { MedusaContainer } from '@medusajs/framework/types'
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import { medusaIntegrationTestRunner } from '@medusajs/test-utils'

jest.setTimeout(180000)

medusaIntegrationTestRunner({
  cwd: path.resolve(__dirname, '../plugin-app'),
  testSuite: ({ api, getContainer }) => {
    let container: MedusaContainer
    let headers: Record<string, string>
    beforeAll(async () => {
      container = getContainer()
      const email = 'pos-admin@example.com'
      const password = 'integration-test-password'
      const user = await container.resolve(Modules.USER).createUsers({ email })
      const auth = container.resolve(Modules.AUTH)
      const { authIdentity, error } = await auth.register('emailpass', { body: { email, password } })
      expect(error).toBeUndefined()
      await auth.updateAuthIdentities({ id: authIdentity!.id, app_metadata: { user_id: user.id } })
      const login = await api.post('/auth/user/emailpass', { email, password })
      expect(login.status).toBe(200)
      headers = { Authorization: `Bearer ${login.data.token}`, 'X-Tally-Protocol': '1' }
      await container.resolve(ContainerRegistrationKeys.PG_CONNECTION)('payment_provider').insert([
        { id: 'pp_acme-pay_acme', is_enabled: true },
        { id: 'pp_old-gateway_old', is_enabled: false },
      ])
    })

    it("lists the store's enabled payment providers, the till's own first", async () => {
      const response = await api.get('/tally/v1/payment-providers', { headers })
      expect(response.status).toBe(200)
      expect(response.data.providers).toEqual([
        { id: 'pp_system_default', name: 'Manual payment', tillCanTake: true },
        { id: 'pp_acme-pay_acme', name: 'Acme Pay', tillCanTake: false },
      ])
    })

    it("is refused without the till's auth", async () => {
      const response = await api.get('/tally/v1/payment-providers', {
        headers: { 'X-Tally-Protocol': '1' }, validateStatus: () => true,
      })
      expect(response.status).toBe(401)
    })
  },
})
