import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { MedusaContainer } from '@medusajs/framework/types'
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import { getOrderDetailWorkflow } from '@medusajs/medusa/core-flows'
import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import type { CommandEnvelope, CommandResult, OrderCreatePayload } from '@tallyui/core' with { 'resolution-mode': 'import' }
import { TALLY_LEDGER_MODULE } from '../../src/modules/tally-ledger'
import type TallyLedgerModuleService from '../../src/modules/tally-ledger/service'
import feeFixture from '../../src/workflows/tally-order-create/__fixtures__/order-create-v5-fee.json'
import shippingFixture from '../../src/workflows/tally-order-create/__fixtures__/order-create-v5-shipping-custom.json'
import type { OrderCreateCustomLine, OrderCreateFee, OrderCreateShipping } from '../../src/workflows/tally-order-create/v5'
import { seed } from './seed'

type Payload = Omit<OrderCreatePayload, 'lines' | 'display'> & {
  lines: Array<Omit<OrderCreatePayload['lines'][number], 'variantId'> & { variantId?: string; custom?: OrderCreateCustomLine }>
  fees?: OrderCreateFee[]; shipping?: OrderCreateShipping[]
  display: NonNullable<OrderCreatePayload['display']> & {
    fees?: Array<{ clientFeeId: string; amountMinor: number }>
    shipping?: Array<{ clientShippingId: string; amountMinor: number }>
  }
}

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
      const email = 'v5-admin@example.com', password = 'integration-test-password'
      const user = await container.resolve(Modules.USER).createUsers({ email })
      const auth = container.resolve(Modules.AUTH)
      const { authIdentity, error } = await auth.register('emailpass', { body: { email, password } })
      expect(error).toBeUndefined()
      await auth.updateAuthIdentities({ id: authIdentity!.id, app_metadata: { user_id: user.id } })
      const login = await api.post('/auth/user/emailpass', { email, password })
      expect(login.status).toBe(200)
      headers = { Authorization: `Bearer ${login.data.token}`, 'X-Tally-Protocol': '1' }
    })

    function command(fixture = feeFixture as typeof feeFixture | typeof shippingFixture, taxableCustom = false) {
      const sale = structuredClone(fixture) as unknown as CommandEnvelope<Payload>
      const payload = sale.payload
      sale.id = randomUUID()
      sale.createdAt = payload.createdAt = new Date().toISOString()
      payload.clientOrderId = randomUUID()
      delete payload.customer
      delete payload.sessionId
      // The seeded store has A at 10.00, B at 5.00 and a 19% region rate; all figures here are exclusive.
      payload.lines.forEach((line, index) => {
        line.clientLineId = randomUUID()
        if (line.custom) {
          if (taxableCustom) line.custom.taxStatus = 'taxable'
        } else {
          line.variantId = payload.fees ? data.variantA : data.variantB
          line.unitPriceMinor = payload.fees ? 1000 : 500
        }
        payload.display.lines[index] = { clientLineId: line.clientLineId, amountMinor: line.unitPriceMinor * line.quantity, discounts: [] }
      })
      for (const charge of [...payload.fees ?? [], ...payload.shipping ?? []]) charge.taxMinor = Math.round(charge.amountMinor * 0.19)
      payload.subtotalMinor = payload.lines.reduce((sum, line) => sum + line.unitPriceMinor * line.quantity, 0)
      const exempt = payload.lines.filter(line => line.custom?.taxStatus === 'none')
        .reduce((sum, line) => sum + line.unitPriceMinor * line.quantity, 0)
      const net = payload.subtotalMinor + [...payload.fees ?? [], ...payload.shipping ?? []].reduce((sum, charge) => sum + charge.amountMinor, 0)
      payload.taxMinor = Math.round((net - exempt) * 0.19)
      payload.totalMinor = net + payload.taxMinor
      payload.payments[0].amountMinor = payload.totalMinor
      Object.assign(payload.display, { subtotalMinor: payload.subtotalMinor, taxMinor: payload.taxMinor, totalMinor: payload.totalMinor })
      payload.taxByRate = [{ ratePpm: 190000, netMinor: net - exempt, taxMinor: payload.taxMinor, grossMinor: net - exempt + payload.taxMinor },
        ...(exempt ? [{ ratePpm: 0, netMinor: exempt, taxMinor: 0, grossMinor: exempt }] : [])]
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
          'items.id', 'items.title', 'items.variant_id', 'items.variant_sku', 'items.quantity', 'items.unit_price',
          'items.requires_shipping', 'items.is_discountable', 'items.is_tax_inclusive', 'items.metadata',
          'shipping_methods.name', 'shipping_methods.amount', 'shipping_methods.is_tax_inclusive',
          'shipping_methods.shipping_option_id', 'shipping_methods.metadata',
          'payment_collections.amount', 'payment_collections.status', 'fulfillments.items.line_item_id'],
      })
      expect(order.status).toBe('completed')
      const { result: detail } = await getOrderDetailWorkflow(container).run({ input: { order_id: order.id, fields: ['payment_status', 'currency_code'] } })
      expect(detail.payment_status).toBe('captured')
      expect(order.payment_collections).toEqual([expect.objectContaining({ status: 'completed' })])
      expect(order.payment_collections.map(collection => Number(collection.amount))).toEqual([sale.payload.totalMinor / 100])
      expect(order.fulfillments.flatMap(fulfillment => fulfillment.items.map(item => item.line_item_id)).sort())
        .toEqual(order.items.map(item => item.id).sort())
      expect(order.metadata.tally_pos_totals).toMatchObject({
        settlement: { subtotalMinor: sale.payload.subtotalMinor, discountMinor: 0, taxMinor: sale.payload.taxMinor, totalMinor: sale.payload.totalMinor },
        display: sale.payload.display, taxByRate: sale.payload.taxByRate,
        charges: JSON.parse(JSON.stringify({ fees: sale.payload.fees, shipping: sale.payload.shipping })),
      })
      return order
    }

    it('golden pair 3.1: a product and a taxable bag fee apply once at the till\'s total, with the fee as a variant-less item', async () => {
      const sale = command()
      expect(sale.payload.totalMinor).toBe(1214)
      const order = await readOrder(await post(sale), sale)
      const fee = order.items.find(item => item.metadata?.tally_fee_uuid === sale.payload.fees![0].clientFeeId)!
      expect(fee).toMatchObject({ title: 'Bag', requires_shipping: false, is_discountable: false, is_tax_inclusive: false })
      expect(fee.variant_id).toBeNull()
      expect(Number(fee.quantity)).toBe(1)
      expect(Number(fee.unit_price)).toBe(0.2)
      expect(order.items).toHaveLength(2)
      expect(await ordersFor(sale)).toHaveLength(1)
    })

    it('golden pair 3.2 as given is refused: invalid_payload, data { reason: tax_status_unsupported, path: lines[1].custom.taxStatus }, and nothing is stored', async () => {
      const sale = command(shippingFixture)
      const result = await post(sale)
      expect(result).toEqual({ id: sale.id, status: 'rejected', error: { code: 'invalid_payload',
        message: expect.stringContaining('payload.lines[1].custom.taxStatus: tax_status_unsupported:'),
        data: { reason: 'tax_status_unsupported', path: 'lines[1].custom.taxStatus' } } })
      expect(await post(sale)).toEqual(result)
      await nothingStored(sale)
    })

    it('golden pair 3.2 with a taxable gift wrap applies: a shipping method, a variant-less custom item, at the till\'s total', async () => {
      const sale = command(shippingFixture, true)
      expect(sale.payload.totalMinor).toBe(1547)
      const order = await readOrder(await post(sale), sale)
      const custom = order.items.find(item => item.metadata?.tally_line_uuid === sale.payload.lines[1].clientLineId)!
      expect(custom).toMatchObject({ title: 'Gift wrap', requires_shipping: false, is_tax_inclusive: false })
      expect(custom.variant_id).toBeNull()
      expect(Number(custom.unit_price)).toBe(3)
      expect(order.items).toHaveLength(2)
      expect(order.shipping_methods).toEqual([expect.objectContaining({ name: 'Local delivery', is_tax_inclusive: false,
        shipping_option_id: null, metadata: { tally_shipping_uuid: sale.payload.shipping![0].clientShippingId, tally_method_id: 'flat_rate' } })])
      expect(Number(order.shipping_methods[0].amount)).toBe(5)
    })

    it('a taxClass on a fee is refused as tax_class_unknown naming fees[0].taxClass', async () => {
      const sale = command()
      sale.payload.fees![0].taxClass = 'standard'
      const result = await post(sale)
      expect(result).toEqual({ id: sale.id, status: 'rejected', error: { code: 'invalid_payload',
        message: expect.stringContaining('payload.fees[0].taxClass: tax_class_unknown:'),
        data: { reason: 'tax_class_unknown', path: 'fees[0].taxClass' } } })
      await nothingStored(sale)
    })

    it('a v5 replay answers as the original: same status and serverRefs, one Medusa order', async () => {
      const sale = command()
      const original = await post(sale)
      expect(original.status).toBe('applied')
      const replay = await post(sale)
      expect(replay).toEqual({ ...original, status: 'duplicate' })
      expect(await post({ ...sale, attempt: 2 })).toEqual(replay)
      expect(await ordersFor(sale)).toHaveLength(1)
    })

    it('version 4 with fees is invalid_payload naming payload.fees: requires version 5', async () => {
      const sale = command()
      sale.version = 4
      expect(await post(sale)).toEqual({ id: sale.id, status: 'rejected', error: { code: 'invalid_payload',
        message: expect.stringContaining('payload.fees: requires version 5') } })
      await nothingStored(sale)
    })

    it('tax-inclusive: a product, a taxable fee and a shipping charge apply once at the till\'s gross total, with no total_mismatch and no figures_mismatch', async () => {
      const sale = command()
      const payload = sale.payload
      // At 19%: gross 11.90 + 1.19 + 5.95 = 19.04; net 10 + 1 + 5 = 16, tax 3.04.
      payload.pricesIncludeTax = true
      payload.lines[0].unitPriceMinor = 1190
      Object.assign(payload.fees![0], { amountMinor: 119, taxMinor: 19 })
      payload.shipping = [{ clientShippingId: randomUUID(), name: 'Local delivery', methodId: 'flat_rate',
        amountMinor: 595, taxStatus: 'taxable', taxMinor: 95 }]
      Object.assign(payload, { subtotalMinor: 1000, taxMinor: 304, totalMinor: 1904 })
      payload.payments[0].amountMinor = 1904
      Object.assign(payload.display, { taxInclusive: true, subtotalMinor: 1190, taxMinor: 304, totalMinor: 1904,
        lines: [{ clientLineId: payload.lines[0].clientLineId, amountMinor: 1190, discounts: [] }],
        fees: [{ clientFeeId: payload.fees![0].clientFeeId, amountMinor: 119 }],
        shipping: [{ clientShippingId: payload.shipping[0].clientShippingId, amountMinor: 595 }],
      })
      payload.taxByRate = [{ ratePpm: 190000, netMinor: 1600, taxMinor: 304, grossMinor: 1904 }]
      const result = await post(sale)
      const order = await readOrder(result, sale)
      expect(Number(order.total)).toBe(19.04)
      expect(order.items).toHaveLength(2)
      const product = order.items.find(item => item.variant_id === data.variantA)!
      expect(product.is_tax_inclusive).toBe(true)
      expect(Number(product.unit_price)).toBe(11.9)
      const fee = order.items.find(item => item.metadata?.tally_fee_uuid === payload.fees![0].clientFeeId)!
      expect(fee).toMatchObject({ title: 'Bag', variant_id: null, is_tax_inclusive: true,
        requires_shipping: false, is_discountable: false })
      expect(Number(fee.quantity)).toBe(1)
      expect(Number(fee.unit_price)).toBe(1.19)
      expect(order.shipping_methods).toEqual([expect.objectContaining({ name: 'Local delivery', is_tax_inclusive: true,
        shipping_option_id: null, metadata: { tally_shipping_uuid: payload.shipping[0].clientShippingId, tally_method_id: 'flat_rate' } })])
      expect(Number(order.shipping_methods[0].amount)).toBe(5.95)
      expect(await post(sale)).toEqual({ ...result, status: 'duplicate' })
      expect(await ordersFor(sale)).toHaveLength(1)
    })

    it('v5 display validation precedes the claim', async () => {
      const sale = command()
      sale.payload.display.fees![0].clientFeeId = randomUUID()
      expect(await post(sale)).toEqual({ id: sale.id, status: 'rejected', error: { code: 'invalid_payload',
        message: expect.stringContaining('payload.display.fees[0].clientFeeId') } })
      await nothingStored(sale)
    })
  },
})
