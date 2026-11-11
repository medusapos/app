import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { MedusaContainer } from '@medusajs/framework/types'
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import type { CommandEnvelope, OrderCreatePayload } from '@tallyui/core' with { 'resolution-mode': 'import' }
import { seed } from './seed'

jest.setTimeout(180000)

medusaIntegrationTestRunner({
  cwd: path.resolve(__dirname, '../plugin-app'),
  testSuite: ({ api, getContainer }) => {
    let container: MedusaContainer
    let data: Awaited<ReturnType<typeof seed>>
    let headers: Record<string, string>
    beforeAll(async () => {
      container = getContainer()
      data = await seed(container)
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
    })
    afterEach(() => jest.restoreAllMocks())

    function command(overrides: Partial<OrderCreatePayload> = {}): CommandEnvelope<OrderCreatePayload> {
      const createdAt = new Date().toISOString()
      return {
        id: randomUUID(), type: 'order.create', version: 1, createdAt, deviceId: 'test-register', attempt: 1,
        payload: {
          clientOrderId: randomUUID(), createdAt, currency: 'EUR', pricesIncludeTax: true,
          lines: [{ clientLineId: randomUUID(), variantId: data.variantA, quantity: 1, unitPriceMinor: 1000 }],
          subtotalMinor: 840, taxMinor: 160, totalMinor: 1000,
          payments: [{ clientPaymentId: randomUUID(), method: 'cash', amountMinor: 1000 }],
          ...overrides,
        },
      }
    }

    function post(commands: unknown[], requestHeaders = headers) {
      return api.post('/tally/v1/commands', { commands }, { headers: requestHeaders, validateStatus: () => true })
    }

    async function sale() {
      const response = await post([command()])
      expect(response.data.results[0].status).toBe('applied')
      return response.data.results[0].serverRefs
    }

    function email(orderId: string, body: unknown) {
      return api.post(`/tally/v1/orders/${orderId}/receipt-email`, body, { headers, validateStatus: () => true })
    }

    it('emails the receipt of a till order through the email provider', async () => {
      const serverRefs = await sale()
      const response = await email(serverRefs.orderId, { email: 'buyer@example.com' })
      expect(response.status).toBe(202)
      expect(response.data).toEqual({ notificationId: expect.any(String), savedToBilling: false })
      const notifications = await container.resolve(Modules.NOTIFICATION).listNotifications({ resource_id: serverRefs.orderId })
      expect(notifications).toHaveLength(1)
      expect(notifications[0]).toMatchObject({
        id: response.data.notificationId, channel: 'email', to: 'buyer@example.com', template: 'tally-pos-receipt', status: 'success',
        data: {
          order: { displayId: serverRefs.displayId, totalMinor: 1000, items: [{ quantity: 1 }] },
          posTotals: { settlement: { totalMinor: 1000 } },
        },
      })
    })

    it('accepts saveToBilling without changing the order', async () => {
      const { orderId } = await sale()
      const query = container.resolve(ContainerRegistrationKeys.QUERY)
      const before = await query.graph({ entity: 'order', fields: ['email'], filters: { id: orderId } })
      const response = await email(orderId, { email: 'buyer@example.com', saveToBilling: true })
      expect(response.status).toBe(202)
      expect(response.data).toMatchObject({ savedToBilling: false })
      const after = await query.graph({ entity: 'order', fields: ['email'], filters: { id: orderId } })
      expect(after.data[0].email).toBe(before.data[0].email)
    })

    it('refuses an invalid address with no notification', async () => {
      const { orderId } = await sale()
      const response = await email(orderId, { email: 'not-an-email' })
      expect(response.status).toBe(400)
      expect(response.data).toMatchObject({ code: 'invalid_payload' })
      expect(await container.resolve(Modules.NOTIFICATION).listNotifications({ resource_id: orderId })).toEqual([])
    })

    it('answers 404 for an unknown order', async () => {
      const response = await email('order_unknown', { email: 'buyer@example.com' })
      expect(response.status).toBe(404)
      expect(response.data).toMatchObject({ code: 'order_not_found' })
    })

    it('answers 503 when the store has no email provider', async () => {
      const { orderId } = await sale()
      await container.resolve(ContainerRegistrationKeys.PG_CONNECTION)('notification_provider')
        .whereRaw('? = any(channels)', ['email']).update({ is_enabled: false })
      const response = await email(orderId, { email: 'buyer@example.com' })
      expect(response.status).toBe(503)
      expect(response.data).toMatchObject({ code: 'receipt_email_unavailable' })
      expect(await container.resolve(Modules.NOTIFICATION).listNotifications({ resource_id: orderId })).toEqual([])
    })

    it('answers 502 when the provider fails', async () => {
      const { orderId } = await sale()
      jest.spyOn(container.resolve(Modules.NOTIFICATION), 'createNotifications').mockRejectedValueOnce(new Error('provider down'))
      const response = await email(orderId, { email: 'buyer@example.com' })
      expect(response.status).toBe(502)
      expect(response.data).toMatchObject({ code: 'receipt_email_failed' })
    })
  },
})
