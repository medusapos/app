import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { MedusaContainer } from '@medusajs/framework/types'
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import { createOrderWorkflow, type CreateOrderWorkflowInput } from '@medusajs/medusa/core-flows'
import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import type { CommandEnvelope, CommandResult, OrderCreatePayload } from '@tallyui/core' with { 'resolution-mode': 'import' }
import feeFixture from '../../src/workflows/tally-order-create/__fixtures__/order-create-v5-fee.json'
import { planOrderCreate } from '../../src/workflows/tally-order-create/plan'
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

    // One v7 cash sale of product A (10.00, tax-exclusive, 19%), with a line discount, a 5.00 shipping charge and a
    // taxable 1.00 fee when asked.
    function command({ discount = 0, shipping = false, fee = false }: { discount?: number; shipping?: boolean; fee?: boolean } = {}) {
      const sale = structuredClone(feeFixture) as unknown as CommandEnvelope<Payload>
      const payload = sale.payload
      sale.id = randomUUID()
      sale.version = 7
      sale.createdAt = payload.createdAt = new Date().toISOString()
      payload.clientOrderId = randomUUID()
      delete payload.customer
      delete payload.sessionId
      if (fee) {
        Object.assign(payload.fees![0], { clientFeeId: randomUUID(), amountMinor: 100, taxMinor: 19 })
        payload.display.fees = [{ clientFeeId: payload.fees![0].clientFeeId, amountMinor: 100 }]
      } else {
        delete payload.fees
        delete payload.display.fees
      }
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
      const net = 1000 - discount + (shipping ? 500 : 0) + (fee ? 100 : 0)
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
      return { items: pick(order.items), shipping: pick(order.shipping_methods ?? []), shippingMethods: order.shipping_methods ?? [],
        orderId: result.serverRefs!.orderId as string }
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

    it('case 4: a crash between create and the drop leaves the promotion on the draft, and the resume drops it', async () => {
      const sale = command()
      const planned = planOrderCreate(sale.payload, { customer: null, commandId: sale.id, salesChannelId: data.channelId,
        region: { id: data.regionId, currency_code: 'eur', country_codes: ['de', 'dk'] },
        location: { id: data.berlinId, address: { address_1: 'Alexanderplatz 1', city: 'Berlin', country_code: 'de', postal_code: '10178' } },
        variants: { [data.variantA]: { id: data.variantA } },
      }, sale.version)
      if (!planned.ok) throw new Error('Expected draft plan')
      const { result: draft } = await createOrderWorkflow(container).run({ input: planned.plan.draftOrder as unknown as CreateOrderWorkflowInput })
      const { data: [crashed] } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({
        entity: 'order', filters: { id: draft.id }, fields: ['is_draft_order', 'items.adjustments.promotion_id'],
      })
      expect(crashed.is_draft_order).toBe(true)
      expect(crashed.items.flatMap(item => item!.adjustments ?? [])).toContainEqual(expect.objectContaining({ promotion_id: expect.any(String) }))
      const order = await applied(sale)
      expect(order.orderId).toBe(draft.id)
      expect(order).toMatchObject({ items: [], shipping: [] })
    })

    it('case 5: a v7 sale with a taxable fee keeps the till\'s figures', async () => {
      const sale = command({ fee: true })
      expect(sale.payload.fees).toHaveLength(1)
      expect(sale.payload.totalMinor).toBe(1309)
      expect(await applied(sale)).toMatchObject({ items: [], shipping: [] })
    })

    it('case 6: a tax-inclusive v7 sale keeps the till\'s figures, and no adjustment has a promotion', async () => {
      const sale = command()
      const payload = sale.payload
      // At 19%: gross 11.90, net 10.00, tax 1.90.
      payload.pricesIncludeTax = true
      payload.lines[0].unitPriceMinor = 1190
      Object.assign(payload, { subtotalMinor: 1000, taxMinor: 190, totalMinor: 1190 })
      payload.payments[0].amountMinor = 1190
      Object.assign(payload.display, { taxInclusive: true, subtotalMinor: 1190, taxMinor: 190, totalMinor: 1190,
        lines: [{ clientLineId: payload.lines[0].clientLineId, amountMinor: 1190, discounts: [] }] })
      payload.taxByRate = [{ ratePpm: 190000, netMinor: 1000, taxMinor: 190, grossMinor: 1190 }]
      expect(await applied(sale)).toMatchObject({ items: [], shipping: [] })
    })

    it('case 7: a dropped automatic promotion in a budgeted campaign leaves no link and no budget usage', async () => {
      const promotions = container.resolve(Modules.PROMOTION)
      const [campaign] = await promotions.createCampaigns([{ name: 'Budgeted', campaign_identifier: 'budgeted-auto',
        budget: { type: 'spend', limit: 1000, currency_code: 'eur' } }])
      const [budgeted] = await promotions.createPromotions([{ code: 'AUTOBUDGET', type: 'standard', is_automatic: true, status: 'active',
        campaign_id: campaign.id,
        application_method: { type: 'percentage', target_type: 'items', allocation: 'across', value: 5, currency_code: 'eur' } }])
      // The control: the budgeted promotion does apply to a draft order on this store.
      const control = await adminDraft({})
      expect(control.items[0].adjustments).toContainEqual(expect.objectContaining({ code: 'AUTOBUDGET', promotion_id: budgeted.id }))
      const order = await applied(command())
      expect(order).toMatchObject({ items: [], shipping: [] })
      const { data: [linked] } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({
        entity: 'order', filters: { id: order.orderId }, fields: ['id', 'promotions.id'],
      })
      expect(linked.promotions ?? []).toEqual([])
      const { data: links } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({
        entity: 'order_promotion', filters: { order_id: order.orderId }, fields: ['promotion_id'],
      })
      expect(links).toEqual([])
      const { budget } = await promotions.retrieveCampaign(campaign.id, { relations: ['budget'] })
      expect(Number(budget!.used)).toBe(0)
    })
  },
})
