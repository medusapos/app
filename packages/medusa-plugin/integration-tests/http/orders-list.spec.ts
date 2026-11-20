import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { CreateOrderDTO, MedusaContainer } from '@medusajs/framework/types'
import { ContainerRegistrationKeys, FeatureFlag, Modules } from '@medusajs/framework/utils'
import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import type { CommandEnvelope, OrderCreatePayload } from '@tallyui/core' with { 'resolution-mode': 'import' }
import { seed } from './seed'

jest.setTimeout(180000)

// Register RBAC before the test runner evaluates medusa-config, so the route's tally_pos:use policy runs.
FeatureFlag.setFlag('rbac', true)

medusaIntegrationTestRunner({
  cwd: path.resolve(__dirname, '../plugin-app'),
  env: { MEDUSA_FF_RBAC: 'true' },
  testSuite: ({ api, getContainer }) => {
    let container: MedusaContainer
    let headers: Record<string, string>
    const sales: Array<{ clientOrderId: string; orderId: string; displayId: string }> = []
    const hidden: string[] = []

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

    beforeAll(async () => {
      container = getContainer()
      const data = await seed(container)
      headers = await loginWithRoles(['role_super_admin'])
      for (const registerId of ['reg_a', 'reg_b']) {
        const createdAt = new Date().toISOString()
        const command: CommandEnvelope<OrderCreatePayload> = {
          id: randomUUID(), type: 'order.create', version: 1, createdAt, deviceId: 'test-register', attempt: 1,
          payload: {
            clientOrderId: randomUUID(), createdAt, currency: 'EUR', pricesIncludeTax: true, registerId,
            lines: [{ clientLineId: randomUUID(), variantId: data.variantA, quantity: 1, unitPriceMinor: 1000 }],
            subtotalMinor: 840, taxMinor: 160, totalMinor: 1000,
            payments: [{ clientPaymentId: randomUUID(), method: 'cash', amountMinor: 1000 }],
          },
        }
        const response = await api.post('/tally/v1/commands', { commands: [command] }, { headers })
        expect(response.data.results[0].status).toBe('applied')
        const { orderId, displayId } = response.data.results[0].serverRefs
        sales.push({ clientOrderId: command.payload.clientOrderId, orderId, displayId })
      }
      const [web] = await container.resolve(Modules.SALES_CHANNEL).createSalesChannels([{ name: 'Web shop' }])
      // CreateOrderDTO has no is_draft_order, though the order model stores it, as Medusa's own draft-order workflow does.
      const draft = { currency_code: 'eur', sales_channel_id: data.channelId, is_draft_order: true, status: 'draft' } as CreateOrderDTO
      const orders = await container.resolve(Modules.ORDER).createOrders([
        { currency_code: 'eur', sales_channel_id: web.id, email: 'web@example.com' }, draft,
      ])
      hidden.push(...orders.map(order => order.id))
    })

    function list(query = '', requestHeaders: Record<string, string> = headers) {
      return api.get(`/tally/v1/orders${query}`, { headers: requestHeaders, validateStatus: () => true })
    }

    it('lists the till channel orders newest first, without other channels or drafts', async () => {
      const response = await list()
      expect(response.status).toBe(200)
      expect(Object.keys(response.data).sort()).toEqual(['hasMore', 'orders', 'total'])
      expect(response.data).toMatchObject({ hasMore: false, total: 2 })
      expect(response.data.orders.map(order => [order.id, order.clientOrderId])).toEqual(
        [...sales].reverse().map(sale => [sale.orderId, sale.clientOrderId]))
      for (const id of hidden) expect(response.data.orders.map(order => order.id)).not.toContain(id)
      expect(response.data.orders[0]).toMatchObject({
        reference: sales[1].displayId, status: 'completed', currency: 'eur', pricesIncludeTax: true, totalMinor: 1000,
        taxMinor: 160, lines: [{ quantity: 1, totalMinor: 840, taxMinor: 160 }],
        payments: [{ method: 'pp_system_default', kind: 'cash', amountMinor: 1000 }], refunds: [],
      })
    })

    it('lists and searches all channels with the same full order rows when requested', async () => {
      const response = await list('?allChannels=true')
      expect(response.status).toBe(200)
      expect(response.data).toMatchObject({ hasMore: false, total: 3 })
      expect(response.data.orders.map(order => order.id).sort()).toEqual([hidden[0], ...sales.map(sale => sale.orderId)].sort())
      const webRow = response.data.orders.find(order => order.id === hidden[0])
      const tillRow = response.data.orders.find(order => order.id === sales[0].orderId)
      const defaultList = await list()
      expect(tillRow).toEqual(defaultList.data.orders.find(order => order.id === sales[0].orderId))
      expect(tillRow).toHaveProperty('clientOrderId', sales[0].clientOrderId)
      expect(Object.keys(webRow).sort()).toEqual(Object.keys(tillRow).filter(key => key !== 'clientOrderId').sort())
      const found = await list(`?allChannels=true&search=${webRow.reference}`)
      expect(found.status).toBe(200)
      expect(found.data.orders.map(order => order.id)).toEqual([webRow.id])
      expect(found.data.total).toBe(1)
      const scoped = await list(`?search=${webRow.reference}`)
      expect([scoped.status, scoped.data]).toEqual([200, { orders: [], hasMore: false, total: 0 }])
      const invalid = await list('?allChannels=yes')
      expect([invalid.status, invalid.data]).toEqual([400, {
        code: 'invalid_query', message: 'allChannels must be true or false',
      }])
    })

    it('pages with hasMore', async () => {
      const first = await list('?perPage=1')
      expect(first.data).toMatchObject({ hasMore: true, total: 2 })
      expect(first.data.orders.map(order => order.id)).toEqual([sales[1].orderId])
      const second = await list('?page=2&perPage=1')
      expect(second.data).toMatchObject({ hasMore: false, total: 2 })
      expect(second.data.orders.map(order => order.id)).toEqual([sales[0].orderId])
    })

    it('finds an order by its display id, and filters by register', async () => {
      const found = await list(`?search=${sales[0].displayId}`)
      expect(found.data.orders.map(order => order.id)).toEqual([sales[0].orderId])
      expect(found.data.total).toBe(1)
      const byRegister = await list('?registerId=reg_b')
      expect(byRegister.data.orders.map(order => order.id)).toEqual([sales[1].orderId])
      const text = await list('?search=no-such-order')
      expect([text.status, text.data]).toEqual([200, { orders: [], hasMore: false, total: 0 }])
    })

    it('refuses without auth 401 and without tally_pos:use 403', async () => {
      expect((await list('', { 'X-Tally-Protocol': '1' })).status).toBe(401)
      const response = await list('', await loginWithRoles([]))
      expect(response.status).toBe(403)
      expect(response.data).toMatchObject({ type: 'forbidden', message: 'Forbidden' })
    })

    it('refuses an unsupported filter', async () => {
      const response = await list('?storeId=x')
      expect([response.status, response.data]).toEqual([400, { code: 'unsupported_order_filter', fields: ['storeId'] }])
    })

    it('answers preflights for the list with GET and for receipt-email with POST', async () => {
      for (const [url, method] of [['/tally/v1/orders', 'GET'], ['/tally/v1/orders/order_x/receipt-email', 'POST']]) {
        const response = await api.options(url, { headers: {
          Origin: 'http://localhost', 'Access-Control-Request-Method': method, 'Access-Control-Request-Headers': 'authorization',
        } })
        expect(response.status).toBe(204)
        expect(response.headers['access-control-allow-methods']).toBe(`${method},OPTIONS`)
      }
    })
  },
})
