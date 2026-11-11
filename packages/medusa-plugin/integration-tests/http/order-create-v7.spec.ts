import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { MedusaContainer } from '@medusajs/framework/types'
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import type { CommandEnvelope, CommandResult, OrderCreatePayload } from '@tallyui/core' with { 'resolution-mode': 'import' }
import { TALLY_LEDGER_MODULE } from '../../src/modules/tally-ledger'
import type TallyLedgerModuleService from '../../src/modules/tally-ledger/service'
import feeFixture from '../../src/workflows/tally-order-create/__fixtures__/order-create-v5-fee.json'
import { seed } from './seed'

// order.create v6 and v7 (ADR 0024): v7 is the base (3 or 5, or 6) plus the sale's note.
type Payload = OrderCreatePayload & { display: NonNullable<OrderCreatePayload['display']> }

jest.setTimeout(180000)

medusaIntegrationTestRunner({
  cwd: path.resolve(__dirname, '../plugin-app'),
  testSuite: ({ api, getContainer }) => {
    let container: MedusaContainer
    let ledger: TallyLedgerModuleService
    let data: Awaited<ReturnType<typeof seed>>
    let headers: Record<string, string>
    beforeAll(async () => {
      container = getContainer()
      ledger = container.resolve(TALLY_LEDGER_MODULE)
      data = await seed(container)
      const email = 'v7-admin@example.com', password = 'integration-test-password'
      const user = await container.resolve(Modules.USER).createUsers({ email })
      const auth = container.resolve(Modules.AUTH)
      const { authIdentity, error } = await auth.register('emailpass', { body: { email, password } })
      expect(error).toBeUndefined()
      await auth.updateAuthIdentities({ id: authIdentity!.id, app_metadata: { user_id: user.id } })
      const login = await api.post('/auth/user/emailpass', { email, password })
      expect(login.status).toBe(200)
      headers = { Authorization: `Bearer ${login.data.token}`, 'X-Tally-Protocol': '1' }
    })

    // One cash sale of product A (10.00, tax-exclusive, 19%), with the fixture's bag fee and a shipping charge when asked.
    function command(version: number, { note, fee = false, shipping = false }: { note?: string; fee?: boolean; shipping?: boolean } = {}) {
      const sale = structuredClone(feeFixture) as unknown as CommandEnvelope<Payload>
      const payload = sale.payload
      sale.id = randomUUID()
      sale.version = version as CommandEnvelope['version']
      sale.createdAt = payload.createdAt = new Date().toISOString()
      payload.clientOrderId = randomUUID()
      delete payload.customer
      delete payload.sessionId
      const line = payload.lines[0]
      Object.assign(line, { clientLineId: randomUUID(), variantId: data.variantA, unitPriceMinor: 1000 })
      payload.display.lines = [{ clientLineId: line.clientLineId, amountMinor: 1000, discounts: [] }]
      if (!fee) {
        delete payload.fees
        delete payload.display.fees
      }
      if (shipping) {
        payload.shipping = [{ clientShippingId: randomUUID(), name: 'Local delivery', methodId: 'flat_rate', amountMinor: 500, taxStatus: 'taxable', taxMinor: 0 }]
        payload.display.shipping = [{ clientShippingId: payload.shipping[0].clientShippingId, amountMinor: 500 }]
      }
      if (note !== undefined) payload.note = note
      const charges = [...payload.fees ?? [], ...payload.shipping ?? []]
      for (const charge of charges) charge.taxMinor = Math.round(charge.amountMinor * 0.19)
      const net = 1000 + charges.reduce((sum, charge) => sum + charge.amountMinor, 0)
      Object.assign(payload, { subtotalMinor: 1000, taxMinor: Math.round(net * 0.19) })
      payload.totalMinor = net + payload.taxMinor
      payload.payments[0].amountMinor = payload.totalMinor
      Object.assign(payload.display, { subtotalMinor: 1000, taxMinor: payload.taxMinor, totalMinor: payload.totalMinor })
      payload.taxByRate = [{ ratePpm: 190000, netMinor: net, taxMinor: payload.taxMinor, grossMinor: payload.totalMinor }]
      return sale
    }

    async function post(sale: CommandEnvelope<Payload>): Promise<CommandResult> {
      const response = await api.post('/tally/v1/commands', { commands: [sale] }, { headers, validateStatus: () => true })
      expect(response.status).toBe(200)
      expect(response.data.results).toHaveLength(1)
      return response.data.results[0]
    }

    function ordersFor(sale: CommandEnvelope<Payload>) {
      return container.resolve(ContainerRegistrationKeys.PG_CONNECTION)('order')
        .whereRaw("metadata->>'tally_client_id' = ?", [sale.payload.clientOrderId])
    }

    async function nothingStored(sale: CommandEnvelope<Payload>) {
      expect(await ledger.listTallyCommands({ id: sale.id })).toHaveLength(0)
      expect(await ordersFor(sale)).toHaveLength(0)
    }

    async function readOrder(result: CommandResult, sale: CommandEnvelope<Payload>) {
      expect(result.status).toBe('applied')
      expect(result.serverRefs!.totalMinor).toBe(sale.payload.totalMinor)
      expect(result.warnings ?? []).not.toEqual(expect.arrayContaining([expect.objectContaining({ code: 'total_mismatch' })]))
      expect(result.warnings ?? []).not.toEqual(expect.arrayContaining([expect.objectContaining({ code: 'figures_mismatch' })]))
      const { data: [order] } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({
        entity: 'order', filters: { id: result.serverRefs!.orderId }, fields: ['id', 'status', 'total', 'metadata',
          'items.id', 'items.title', 'items.variant_id', 'items.unit_price', 'items.requires_shipping', 'items.is_discountable',
          'items.metadata', 'shipping_methods.name', 'shipping_methods.amount', 'shipping_methods.metadata'],
      })
      expect(order.status).toBe('completed')
      return order
    }

    it('case 1: a v7 cash order with one product and a note applies, and the Medusa order keeps the note as metadata.tally_note', async () => {
      const sale = command(7, { note: 'Gift wrap, please. Collect after 5pm.' })
      expect(sale.payload.totalMinor).toBe(1190)
      const order = await readOrder(await post(sale), sale)
      expect(order.metadata.tally_note).toBe('Gift wrap, please. Collect after 5pm.')
      expect(order.items).toHaveLength(1)
      expect(order.items[0].metadata).toEqual({ tally_line_uuid: sale.payload.lines[0].clientLineId })
      expect(await ordersFor(sale)).toHaveLength(1)
    })

    it('case 2: a v7 order over base 5 (a product, a taxable fee, a shipping charge and a note) applies at the till\'s total', async () => {
      const sale = command(7, { note: 'Leave at the back door', fee: true, shipping: true })
      expect(sale.payload.totalMinor).toBe(1809)
      const order = await readOrder(await post(sale), sale)
      expect(Number(order.total)).toBeCloseTo(18.088, 6)
      expect(order.metadata.tally_note).toBe('Leave at the back door')
      expect(order.items).toHaveLength(2)
      const fee = order.items.find(item => item.metadata?.tally_fee_uuid === sale.payload.fees![0].clientFeeId)!
      expect(fee).toMatchObject({ title: 'Bag', variant_id: null, requires_shipping: false, is_discountable: false })
      expect(Number(fee.unit_price)).toBe(0.2)
      expect(order.shipping_methods).toEqual([expect.objectContaining({ name: 'Local delivery',
        metadata: { tally_shipping_uuid: sale.payload.shipping![0].clientShippingId, tally_method_id: 'flat_rate' } })])
      expect(Number(order.shipping_methods[0].amount)).toBe(5)
      expect(order.metadata.tally_pos_totals).toMatchObject({
        charges: JSON.parse(JSON.stringify({ fees: sale.payload.fees, shipping: sale.payload.shipping })) })
    })

    it('case 3: a v7 order with a coupon, or with only a display coupon, is rejected coupon_invalid and nothing is stored', async () => {
      const coupon = command(7, { note: 'n' })
      coupon.payload.coupons = [{ code: 'SAVE10', couponId: 'coupon_1', discountMinor: 100, discountTaxMinor: 19 }]
      const display = command(6)
      display.payload.display.coupons = [{ code: 'SAVE10', amountMinor: 100 }]
      for (const sale of [coupon, display]) {
        expect(await post(sale)).toEqual({ id: sale.id, status: 'rejected', error: {
          code: 'coupon_invalid', message: 'this store does not apply till coupons yet' } })
        await nothingStored(sale)
      }
      const empty = command(7, { note: 'n' })
      empty.payload.coupons = []
      empty.payload.display.coupons = []
      expect((await post(empty)).status).toBe('applied')
    })

    it('case 4: a v6 order with regularUnitPriceMinor and attributes on its line applies, and the item metadata keeps them', async () => {
      const sale = command(6)
      Object.assign(sale.payload.lines[0], { regularUnitPriceMinor: 1200, attributes: { Size: 'M', Colour: 'Blue' } })
      const order = await readOrder(await post(sale), sale)
      expect(order.items).toHaveLength(1)
      expect(Number(order.items[0].unit_price)).toBe(10)
      expect(order.items[0].metadata).toEqual({ tally_line_uuid: sale.payload.lines[0].clientLineId,
        tally_regular_unit_price_minor: 1200, tally_attributes: { Size: 'M', Colour: 'Blue' } })
      expect(order.metadata).not.toHaveProperty('tally_note')
    })

    it('case 5: a v7 replay answers as the original: same status and serverRefs, one Medusa order', async () => {
      const sale = command(7, { note: 'Gift wrap, please' })
      const original = await post(sale)
      expect(original.status).toBe('applied')
      const replay = await post(sale)
      expect(replay).toEqual({ ...original, status: 'duplicate' })
      expect(await post({ ...sale, attempt: 2 })).toEqual(replay)
      expect(await ordersFor(sale)).toHaveLength(1)
    })

    it('case 6: a v5 order carrying a note is invalid_payload naming payload.note: requires version 7', async () => {
      const sale = command(5, { note: 'Gift wrap, please' })
      expect(await post(sale)).toEqual({ id: sale.id, status: 'rejected', error: { code: 'invalid_payload',
        message: expect.stringContaining('payload.note: requires version 7') } })
      await nothingStored(sale)
    })
  },
})
