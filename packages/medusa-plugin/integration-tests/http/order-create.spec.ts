import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { MedusaContainer } from '@medusajs/framework/types'
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import { createOrderWorkflow, getOrderDetailWorkflow, type CreateOrderWorkflowInput } from '@medusajs/medusa/core-flows'
import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import type { CommandEnvelope, CommandResult, OrderCreatePayload } from '@tallyui/core'
import { runOrderCreate } from '../../src/workflows'
import { planOrderCreate } from '../../src/workflows/tally-order-create/plan'
import { seed } from './seed'

jest.setTimeout(180000)

medusaIntegrationTestRunner({
  cwd: path.resolve(__dirname, '../app'),
  testSuite: ({ getContainer }) => {
    let container: MedusaContainer
    let data: Awaited<ReturnType<typeof seed>>
    beforeAll(async () => {
      container = getContainer()
      data = await seed(container)
    })

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

    async function readOrder(result: CommandResult) {
      expect(result.status).toBe('applied')
      const { data: [order] } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({
        entity: 'order', filters: { id: result.serverRefs!.orderId },
        fields: ['id', 'display_id', 'status', 'total', 'raw_total', 'tax_total', 'metadata',
          'items.id', 'items.variant_id', 'items.quantity', 'items.unit_price', 'items.requires_shipping',
          'items.metadata', 'items.tax_lines.rate', 'payment_collections.amount', 'payment_collections.status',
          'fulfillments.id', 'fulfillments.location_id', 'fulfillments.shipping_option_id'],
      })
      expect(order.status).toBe('completed')
      // Medusa derives payment_status in its order-detail workflow, as used by the Admin API.
      const { result: detail } = await getOrderDetailWorkflow(container).run({
        input: { order_id: order.id, fields: ['payment_status', 'currency_code'] },
      })
      expect(detail.payment_status).toBe('captured')
      expect(order.payment_collections).toEqual([expect.objectContaining({ status: 'completed' })])
      expect(result.serverRefs!.displayId).toBe(String(order.display_id))
      return order
    }

    function ordersFor(clientOrderId: string) {
      return container.resolve(ContainerRegistrationKeys.PG_CONNECTION)('order')
        .whereRaw("metadata->>'tally_client_id' = ?", [clientOrderId])
    }

    async function stockA() {
      const [level] = await container.resolve(Modules.INVENTORY).listInventoryLevels({
        inventory_item_id: data.inventoryA, location_id: data.berlinId,
      })
      return Number(level.stocked_quantity)
    }

    it('tax-inclusive override keeps POS prices and metadata, captures exactly 17, and reduces stock', async () => {
      const sale = command({
        lines: [{ clientLineId: randomUUID(), variantId: data.variantA, quantity: 2, unitPriceMinor: 850 }],
        subtotalMinor: 1429, taxMinor: 271, totalMinor: 1700,
        payments: [{ clientPaymentId: randomUUID(), method: 'cash', amountMinor: 2000 }],
      })
      expect(await stockA()).toBe(10)
      const result = await runOrderCreate(container, sale)
      const order = await readOrder(result)
      expect(result.warnings).toBeUndefined()
      expect(result.serverRefs!.totalMinor).toBe(1700)
      expect(order.items).toHaveLength(1)
      expect(Number(order.items[0].unit_price)).toBe(8.5)
      expect(Number(order.items[0].quantity)).toBe(2)
      expect(order.items[0].metadata).toMatchObject({ tally_line_uuid: sale.payload.lines[0].clientLineId })
      expect(order.metadata).toMatchObject({ tally_client_id: sale.payload.clientOrderId, tally_created_at: sale.payload.createdAt })
      expect(order.items[0].tax_lines.map(line => Number(line.rate))).toEqual([19])
      expect(Number(order.total)).toBe(17)
      expect(Number(order.tax_total)).toBeCloseTo(2.71, 2)
      expect(order.payment_collections.map(collection => Number(collection.amount))).toEqual([17])
      expect(order.fulfillments).toEqual([expect.objectContaining({ location_id: data.berlinId, shipping_option_id: data.berlinShippingOptionId })])
      expect(await stockA()).toBe(8)
    })

    it('tax-exclusive prices total 11.90 with a collection of exactly 11.9', async () => {
      const sale = command({
        pricesIncludeTax: false, subtotalMinor: 1000, taxMinor: 190, totalMinor: 1190,
        payments: [{ clientPaymentId: randomUUID(), method: 'cash', amountMinor: 1190 }],
      })
      const result = await runOrderCreate(container, sale)
      const order = await readOrder(result)
      expect(Number(order.total)).toBe(11.9)
      expect(order.payment_collections.map(collection => Number(collection.amount))).toEqual([11.9])
      expect(result.serverRefs!.totalMinor).toBe(1190)
      expect(result.warnings).toBeUndefined()
    })

    it.each([31, 30])('unrounded total 0.3094 with POS total %i keeps the POS collection amount and reports rounded server total', async totalMinor => {
      const sale = command({
        pricesIncludeTax: false, subtotalMinor: 26, taxMinor: totalMinor - 26, totalMinor,
        lines: [{ clientLineId: randomUUID(), variantId: data.variantA, quantity: 1, unitPriceMinor: 26 }],
        payments: [{ clientPaymentId: randomUUID(), method: 'cash', amountMinor: totalMinor }],
      })
      const result = await runOrderCreate(container, sale)
      const order = await readOrder(result)
      expect(Number(order.raw_total.value)).toBe(0.3094)
      expect(result.serverRefs!.totalMinor).toBe(31)
      expect(result.warnings).toEqual(totalMinor === 31 ? undefined : [{ code: 'total_mismatch', expectedMinor: 30, serverMinor: 31 }])
      expect(order.payment_collections.map(collection => Number(collection.amount))).toEqual([totalMinor / 100])
    })

    it('completes mixed shipping groups with the appropriate number of fulfillments', async () => {
      const sale = command({
        lines: [
          { clientLineId: randomUUID(), variantId: data.variantA, quantity: 1, unitPriceMinor: 1000 },
          { clientLineId: randomUUID(), variantId: data.variantB, quantity: 1, unitPriceMinor: 500 },
        ],
        subtotalMinor: 1261, taxMinor: 239, totalMinor: 1500,
        payments: [{ clientPaymentId: randomUUID(), method: 'cash', amountMinor: 1500 }],
      })
      const order = await readOrder(await runOrderCreate(container, sale))
      const itemB = order.items.find(item => item.variant_id === data.variantB)!
      expect(order.fulfillments).toHaveLength(itemB.requires_shipping ? 1 : 2)
      for (const fulfillment of order.fulfillments) {
        expect(fulfillment).toMatchObject({ location_id: data.berlinId, shipping_option_id: data.berlinShippingOptionId })
      }
    })

    it('replays the same command with the same orderId and creates only one order', async () => {
      const sale = command()
      const first = await runOrderCreate(container, sale)
      const second = await runOrderCreate(container, sale)
      await readOrder(first)
      expect(second).toEqual(first)
      expect(await ordersFor(sale.payload.clientOrderId)).toHaveLength(1)
      expect(await stockA()).toBe(9)
    })

    it('deletes a leftover draft before creating a new completed order', async () => {
      const sale = command()
      const planned = planOrderCreate(sale.payload, {
        commandId: sale.id, salesChannelId: data.channelId,
        region: { id: data.regionId, currency_code: 'eur', country_codes: ['de', 'dk'] },
        location: { id: data.berlinId, address: { address_1: 'Alexanderplatz 1', city: 'Berlin', country_code: 'de', postal_code: '10178' } },
        variants: { [data.variantA]: { id: data.variantA } },
      })
      if (!planned.ok) throw new Error('Expected draft plan')
      const { result: draft } = await createOrderWorkflow(container).run({ input: planned.plan.draftOrder as unknown as CreateOrderWorkflowInput })
      const order = await readOrder(await runOrderCreate(container, sale))
      expect(order.id).not.toBe(draft.id)
      const oldDraft = await ordersFor(sale.payload.clientOrderId).where('id', draft.id).first()
      expect(oldDraft === undefined || oldDraft.deleted_at !== null).toBe(true)
      expect(await ordersFor(sale.payload.clientOrderId).whereNull('deleted_at')).toHaveLength(1)
    })

    it.each(['unknown_variant', 'underpaid', 'unsupported_currency', 'insufficient_stock'])(
      'rejects %s without creating an order', async code => {
        const sale = command()
        if (code === 'unknown_variant') sale.payload.lines[0].variantId = 'variant_unknown'
        if (code === 'underpaid') sale.payload.payments[0].amountMinor = 999
        if (code === 'unsupported_currency') sale.payload.currency = 'USD'
        if (code === 'insufficient_stock') {
          sale.payload.lines[0] = { ...sale.payload.lines[0], variantId: data.variantC, quantity: 2, unitPriceMinor: 300 }
          sale.payload.subtotalMinor = 504
          sale.payload.taxMinor = 96
          sale.payload.totalMinor = 600
          sale.payload.payments[0].amountMinor = 600
        }
        const result = await runOrderCreate(container, sale)
        expect(result).toMatchObject({ id: sale.id, status: 'rejected', error: { code } })
        expect(result.serverRefs).toBeUndefined()
        expect(await ordersFor(sale.payload.clientOrderId)).toHaveLength(0)
      }
    )

    it('compensates a fulfillment failure after payment, leaving no live order, reservations, or stock change', async () => {
      const sale = command({ locationId: data.spareId })
      const before = await stockA()
      // A call-through spy observes the real system payment capture; no boundary is mocked.
      const capture = jest.spyOn(container.resolve(Modules.PAYMENT), 'capturePayment')
      try {
        await expect(runOrderCreate(container, sale)).rejects.toMatchObject({
          __isMedusaError: true, type: 'not_found',
          message: `Inventory level for item ${data.inventoryA} and location ${data.spareId} not found`,
        })
        expect(capture).toHaveBeenCalledTimes(1)
      } finally {
        capture.mockRestore()
      }
      expect(await ordersFor(sale.payload.clientOrderId).whereNull('deleted_at').whereNot('status', 'canceled')).toHaveLength(0)
      expect(await container.resolve(Modules.INVENTORY).listReservationItems({ inventory_item_id: data.inventoryA })).toHaveLength(0)
      expect(await stockA()).toBe(before)
    })
  },
})
