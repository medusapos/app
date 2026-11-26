import path from 'node:path'
import type { MedusaContainer } from '@medusajs/framework/types'
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import { createRegionsWorkflow } from '@medusajs/medusa/core-flows'
import { medusaIntegrationTestRunner } from '@medusajs/test-utils'

jest.setTimeout(180000)

medusaIntegrationTestRunner({
  cwd: path.resolve(__dirname, '../plugin-app'),
  testSuite: ({ api, getContainer }) => {
    let container: MedusaContainer
    let headers: Record<string, string>
    let regionId: string
    let emptyRegionId: string
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
      const pg = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
      // The old gateway is linked while enabled, then disabled, so the regions keep a link to a disabled provider.
      await pg('payment_provider').insert([
        { id: 'pp_acme-pay_acme', is_enabled: true },
        { id: 'pp_old-gateway_old', is_enabled: true },
      ])
      const { result: regions } = await createRegionsWorkflow(container).run({ input: { regions: [
        { name: 'Till region', currency_code: 'eur', payment_providers: ['pp_system_default', 'pp_old-gateway_old'] },
        { name: 'Old gateway region', currency_code: 'eur', payment_providers: ['pp_old-gateway_old'] },
      ] } })
      regionId = regions[0].id
      emptyRegionId = regions[1].id
      await pg('payment_provider').where({ id: 'pp_old-gateway_old' }).update({ is_enabled: false })
    })

    it("lists the store's enabled payment providers, the till's own first", async () => {
      const response = await api.get('/tally/v1/payment-providers', { headers })
      expect(response.status).toBe(200)
      expect(response.data.providers).toEqual([
        { id: 'pp_system_default', name: 'Manual payment', tillCanTake: true, terminal: false },
        { id: 'pp_acme-pay_acme', name: 'Acme Pay', tillCanTake: false, terminal: false },
      ])
    })

    it("with region_id lists only that region's enabled providers", async () => {
      const response = await api.get(`/tally/v1/payment-providers?region_id=${regionId}`, { headers })
      expect(response.status).toBe(200)
      expect(response.data).toEqual({ providers: [
        { id: 'pp_system_default', name: 'Manual payment', tillCanTake: true, terminal: false },
      ] })
    })

    it('answers 404 region_not_found for an unknown region_id', async () => {
      const response = await api.get('/tally/v1/payment-providers?region_id=reg_missing', {
        headers, validateStatus: () => true,
      })
      expect(response.status).toBe(404)
      expect(response.data).toEqual({ code: 'region_not_found' })
    })

    it('answers an empty list for a region with no enabled provider', async () => {
      const response = await api.get(`/tally/v1/payment-providers?region_id=${emptyRegionId}`, { headers })
      expect(response.status).toBe(200)
      expect(response.data).toEqual({ providers: [] })
    })

    it("is refused without the till's auth", async () => {
      const response = await api.get('/tally/v1/payment-providers', {
        headers: { 'X-Tally-Protocol': '1' }, validateStatus: () => true,
      })
      expect(response.status).toBe(401)
    })
  },
})
