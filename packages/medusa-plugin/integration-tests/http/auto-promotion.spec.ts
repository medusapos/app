import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { MedusaContainer } from '@medusajs/framework/types'
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import type { CommandEnvelope, CommandResult, OrderCreatePayload } from '@tallyui/core' with { 'resolution-mode': 'import' }
import feeFixture from '../../src/workflows/tally-order-create/__fixtures__/order-create-v5-fee.json'
import { seed } from './seed'

// #290: the store's automatic promotions stay off POS orders, which keep the till's figures; admin draft orders keep them.
type Payload = OrderCreatePayload & { display: NonNullable<OrderCreatePayload['display']> }
type Adjustment = { code: string | null; promotion_id: string | null; amount: number; description: string | null }

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
      const email = 'auto-promotion-admin@example.com', password = 'integration-test-password'
      const user = await container.resolve(Modules.USER).createUsers({ email })
      const auth = container.resolve(Modules.AUTH)
      const { authIdentity, error } = await auth.register('emailpass', { body: { email, password } })
      expect(error).toBeUndefined()
      await auth.updateAuthIdentities({ id: authIdentity!.id, app_metadata: { user_id: user.id } })
      const login = await api.post('/auth/user/emailpass', { email, password })
      expect(login.status).toBe(200)
      headers = { Authorization: `Bearer ${login.data.token}`, 'X-Tally-Protocol': '1' }
      // The store's automatic 10% off items, live in every case.
      await container.resolve(Modules.PROMOTION).createPromotions({
        code: 'AUTO10', type: 'standard', is_automatic: true, status: 'active',
        application_method: { type: 'percentage', target_type: 'items', allocation: 'across', value: 10, currency_code: 'eur' },
      })
    })

    // One v7 cash sale of product A (10.00, tax-exclusive, 19%), with a line discount and a 5.00 shipping charge when asked.
    function command({ discount = 0, shipping = false }: { discount?: number; shipping?: boolean } = {}) {
      const sale = structuredClone(feeFixture) as unknown as CommandEnvelope<Payload>
      const payload = sale.payload
      sale.id = randomUUID()
      sale.version = 7
      sale.createdAt = payload.createdAt = new Date().toISOString()
      payload.clientOrderId = randomUUID()
      delete payload.customer
      delete payload.sessionId
      delete payload.fees
      delete payload.display.fees
      const line = payload.lines[0]
      Object.assign(line, { clientLineId: randomUUID(), variantId: data.variantA, unitPriceMinor: 1000,
        ...(discount ? { discountMinor: discount } : {}) })
      payload.display.lines = [{ clientLineId: line.clientLineId, amountMinor: 1000 - discount,
        discounts: discount ? [{ discountId: 'd', label: 'Sale', amountMinor: discount }] : [] }]
      if (shipping) {
        payload.shipping = [{ clientShippingId: randomUUID(), name: 'Local delivery', methodId: 'flat_rate', amountMinor: 500,
          taxStatus: 'taxable', taxMinor: 95 }]
        payload.display.shipping = [{ clientShippingId: payload.shipping[0].clientShippingId, amountMinor: 500 }]
      }
      const net = 1000 - discount + (shipping ? 500 : 0)
      const tax = Math.round(net * 0.19)
      Object.assign(payload, { subtotalMinor: 1000 - discount, taxMinor: tax, totalMinor: net + tax,
        ...(discount ? { discountMinor: discount } : {}) })
      payload.payments[0].amountMinor = payload.totalMinor
      Object.assign(payload.display, { subtotalMinor: 1000, discountMinor: discount, taxMinor: tax, totalMinor: net + tax })
      payload.taxByRate = [{ ratePpm: 190000, netMinor: net, taxMinor: tax, grossMinor: net + tax }]
      payload.note = 'auto promotion'
      return sale
    }

    // Posts the sale, checks it applied at the till's figures, and returns its order's adjustments.
    async function applied(sale: CommandEnvelope<Payload>) {
      const response = await api.post('/tally/v1/commands', { commands: [sale] }, { headers, validateStatus: () => true })
      expect(response.status).toBe(200)
      const result: CommandResult = response.data.results[0]
      expect(result.status).toBe('applied')
      expect(result.warnings ?? []).toEqual([])
      expect(result.serverRefs!.totalMinor).toBe(sale.payload.totalMinor)
      const { data: [order] } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({
        entity: 'order', filters: { id: result.serverRefs!.orderId }, fields: ['id', 'status', 'total', 'tax_total', 'summary.*',
          'items.adjustments.*', 'shipping_methods.amount', 'shipping_methods.adjustments.*'],
      })
      expect(order.status).toBe('completed')
      expect(Math.round(Number(order.total) * 100)).toBe(sale.payload.totalMinor)
      expect(Math.round(Number(order.tax_total) * 100)).toBe(sale.payload.taxMinor)
      expect(Number((order.summary as { pending_difference?: unknown }).pending_difference)).toBe(0)
      const pick = (rows: unknown) => (rows as Array<{ adjustments?: Adjustment[] }>).flatMap(row => row.adjustments ?? [])
        .map(({ code, promotion_id, amount, description }) => ({ code, promotion_id, amount: Number(amount), description }))
      return { items: pick(order.items), shipping: pick(order.shipping_methods ?? []), shippingMethods: order.shipping_methods ?? [] }
    }

    async function adminDraft(body: Record<string, unknown>) {
      const response = await api.post('/admin/draft-orders', { email: 'draft@example.com', region_id: data.regionId,
        sales_channel_id: data.channelId, items: [{ variant_id: data.variantA, quantity: 1 }], ...body },
      { headers, validateStatus: () => true })
      expect(response.status).toBe(200)
      return response.data.draft_order
    }

    it('case 1: with an automatic 10% items promotion, v7 sales with and without a POS line discount keep the till\'s figures', async () => {
      const plain = command()
      expect(plain.payload.totalMinor).toBe(1190)
      expect(await applied(plain)).toMatchObject({ items: [], shipping: [] })
      const discounted = command({ discount: 100 })
      expect(discounted.payload.totalMinor).toBe(1071)
      expect(await applied(discounted)).toMatchObject({ shipping: [],
        items: [{ code: null, promotion_id: null, amount: 1, description: 'POS discount' }] })
    })

    it('case 2: with an automatic 100% shipping promotion, a v7 sale with a shipping charge keeps it, and no adjustment has a promotion', async () => {
      await container.resolve(Modules.PROMOTION).createPromotions({
        code: 'FREESHIP', type: 'standard', is_automatic: true, status: 'active',
        application_method: { type: 'percentage', target_type: 'shipping_methods', allocation: 'across', value: 100, currency_code: 'eur' },
      })
      // The promotion does apply to a draft order's shipping method.
      const draft = await adminDraft({ shipping_methods: [{ name: 'Local delivery', shipping_option_id: data.berlinShippingOptionId, amount: 5 }] })
      expect(draft.shipping_methods[0].adjustments).toEqual([expect.objectContaining({ code: 'FREESHIP' })])
      const sale = command({ shipping: true })
      expect(sale.payload.totalMinor).toBe(1785)
      const order = await applied(sale)
      expect(order).toMatchObject({ items: [], shipping: [] })
      expect(order.shippingMethods).toHaveLength(1)
      expect(Number(order.shippingMethods[0].amount)).toBe(5)
    })

    it('case 3: the control, an admin draft order on the same store still gets the automatic items promotion', async () => {
      const draft = await adminDraft({})
      expect(draft.items[0].adjustments).toEqual([expect.objectContaining({ code: 'AUTO10' })])
    })
  },
})
