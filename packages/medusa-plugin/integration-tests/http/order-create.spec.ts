import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { MedusaContainer } from '@medusajs/framework/types'
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import {
  convertDraftOrderWorkflow, createOrderFulfillmentWorkflow, createOrderPaymentCollectionWorkflow,
  createOrderWorkflow, createPaymentSessionsWorkflow, getOrderDetailWorkflow, markPaymentCollectionAsPaid, type CreateOrderWorkflowInput,
} from '@medusajs/medusa/core-flows'
import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import type { CommandEnvelope, CommandResult, OrderCreatePayload } from '@tallyui/core'
import { runOrderCreate } from '../../src/workflows'
import { planOrderCreate } from '../../src/workflows/tally-order-create/plan'
import { takeBackStockWorkflow } from '../../src/workflows/tally-order-create/workflow'
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
          'items.metadata', 'items.is_tax_inclusive', 'items.tax_lines.rate','payment_collections.amount', 'payment_collections.status',
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

    it('mixed modes: a taxInclusive false line in a tax-inclusive order records the till total with no total_mismatch', async () => {
      // 19%: A inclusive 1000 = net round(1000 / 1.19) 840 + tax 160 (as command()); B exclusive 1000 + tax 190 = 1190.
      const sale = command({
        lines: [
          { clientLineId: randomUUID(), variantId: data.variantA, quantity: 1, unitPriceMinor: 1000 },
          { clientLineId: randomUUID(), variantId: data.variantB, quantity: 1, unitPriceMinor: 1000, taxInclusive: false },
        ],
        subtotalMinor: 840 + 1000, taxMinor: 160 + 190, totalMinor: 1000 + 1190,
        payments: [{ clientPaymentId: randomUUID(), method: 'cash', amountMinor: 2190 }],
      })
      const result = await runOrderCreate(container, sale)
      const order = await readOrder(result)
      expect(result.warnings).toBeUndefined()
      expect(result.serverRefs!.totalMinor).toBe(2190)
      expect(Number(order.total)).toBe(21.9)
      expect(Number(order.tax_total)).toBeCloseTo(3.4966, 4) // 10 - 10 / 1.19 + 1.90
      expect(order.payment_collections.map(collection => Number(collection.amount))).toEqual([21.9])
      const modes = Object.fromEntries(order.items.map(item => [item.variant_id, item.is_tax_inclusive]))
      expect(modes).toEqual({ [data.variantA]: true, [data.variantB]: false })
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

    async function createDraft(sale: CommandEnvelope<OrderCreatePayload>, shortfall = 0) {
      const planned = planOrderCreate(sale.payload, {
        commandId: sale.id, salesChannelId: data.channelId,
        region: { id: data.regionId, currency_code: 'eur', country_codes: ['de', 'dk'] },
        location: { id: data.berlinId, address: { address_1: 'Alexanderplatz 1', city: 'Berlin', country_code: 'de', postal_code: '10178' } },
        variants: Object.fromEntries(sale.payload.lines.map(line => [line.variantId, { id: line.variantId }])),
      })
      if (!planned.ok) throw new Error('Expected draft plan')
      if (shortfall) {
        await container.resolve(Modules.INVENTORY).adjustInventory(data.inventoryC, data.berlinId, shortfall)
        planned.plan.draftOrder.metadata.tally_stock_topups = [{
          inventory_item_id: data.inventoryC, location_id: data.berlinId, shortfall,
        }]
      }
      const { result } = await createOrderWorkflow(container).run({ input: planned.plan.draftOrder as unknown as CreateOrderWorkflowInput })
      return result
    }

    function shortSale(variantId = data.variantC) {
      return command({
        lines: [{ clientLineId: randomUUID(), variantId, quantity: 2, unitPriceMinor: 300 }],
        subtotalMinor: 504, taxMinor: 96, totalMinor: 600,
        payments: [{ clientPaymentId: randomUUID(), method: 'cash', amountMinor: 600 }],
      })
    }

    async function expectStock(inventoryItemId: string, stocked: number, reserved = 0) {
      const [level] = await container.resolve(Modules.INVENTORY).listInventoryLevels({
        inventory_item_id: inventoryItemId, location_id: data.berlinId,
      })
      expect(Number(level.stocked_quantity)).toBe(stocked)
      expect(Number(level.reserved_quantity)).toBe(reserved)
      const reservations = await container.resolve(Modules.INVENTORY).listReservationItems({ inventory_item_id: inventoryItemId })
      expect(reservations.reduce((sum, item) => sum + Number(item.quantity), 0)).toBe(reserved)
    }

    it('records a short sale, warns, and leaves negative stock without reservations', async () => {
      const sale = shortSale()
      const result = await runOrderCreate(container, sale)
      const order = await readOrder(result)
      expect(result.warnings).toEqual([{ code: 'insufficient_stock', variantId: data.variantC, quantity: 1 }])
      expect(order.payment_collections.map(collection => Number(collection.amount))).toEqual([6])
      expect(order.fulfillments).toHaveLength(1)
      await expectStock(data.inventoryC, -1)
    })

    it('counts another pending order reservation against availability', async () => {
      const pending = await createDraft(command())
      await convertDraftOrderWorkflow(container).run({ input: { id: pending.id } })
      const before = await stockA()
      const sale = command({
        lines: [{ clientLineId: randomUUID(), variantId: data.variantA, quantity: before, unitPriceMinor: 1000 }],
        subtotalMinor: 840 * before, taxMinor: 160 * before, totalMinor: 1000 * before,
        payments: [{ clientPaymentId: randomUUID(), method: 'cash', amountMinor: 1000 * before }],
      })
      const result = await runOrderCreate(container, sale)
      await readOrder(result)
      expect(result.warnings).toEqual([{ code: 'insufficient_stock', variantId: data.variantA, quantity: 1 }])
      await expectStock(data.inventoryA, before - sale.payload.lines[0].quantity, 1)
    })

    it('creates a missing level and leaves it at minus the sold quantity', async () => {
      const result = await runOrderCreate(container, shortSale(data.variantD))
      await readOrder(result)
      expect(result.warnings).toEqual([{ code: 'insufficient_stock', variantId: data.variantD, quantity: 2 }])
      await expectStock(data.inventoryD, -2)
    })

    it('does not take stock back twice after a crash inside the take-back', async () => {
      const sale = shortSale()
      const draft = await createDraft(sale, 1)
      await convertDraftOrderWorkflow(container).run({ input: { id: draft.id } })
      const { result: [collection] } = await createOrderPaymentCollectionWorkflow(container).run({ input: { order_id: draft.id, amount: 6 } })
      await markPaymentCollectionAsPaid(container).run({ input: { order_id: draft.id, payment_collection_id: collection.id } })
      await createOrderFulfillmentWorkflow(container).run({ input: {
        order_id: draft.id, items: draft.items!.map(item => ({ id: item.id, quantity: Number(item.quantity) })),
        location_id: data.berlinId, shipping_option_id: data.berlinShippingOptionId, no_notification: true,
      } })
      await container.resolve(Modules.INVENTORY).adjustInventory(data.inventoryC, data.berlinId, -1)
      await container.resolve(Modules.ORDER).updateOrders(draft.id, { metadata: { ...draft.metadata, tally_stock_take_back_started: true } })
      const order = await readOrder(await runOrderCreate(container, sale))
      expect(order.metadata!.tally_stock_topups_reversed).toBe(true)
      await expectStock(data.inventoryC, -1)
    })

    it('skips take-back when its marker was set but the adjustment never happened', async () => {
      const [before] = await container.resolve(Modules.INVENTORY).listInventoryLevels({
        inventory_item_id: data.inventoryC, location_id: data.berlinId,
      })
      const quantity = Number(before.stocked_quantity) + 1
      const sale = command({
        lines: [{ clientLineId: randomUUID(), variantId: data.variantC, quantity, unitPriceMinor: 300 }],
        subtotalMinor: 252 * quantity, taxMinor: 48 * quantity, totalMinor: 300 * quantity,
        payments: [{ clientPaymentId: randomUUID(), method: 'cash', amountMinor: 300 * quantity }],
      })
      const draft = await createDraft(sale, 1)
      await convertDraftOrderWorkflow(container).run({ input: { id: draft.id } })
      const { result: [collection] } = await createOrderPaymentCollectionWorkflow(container).run({
        input: { order_id: draft.id, amount: sale.payload.totalMinor / 100 },
      })
      await markPaymentCollectionAsPaid(container).run({ input: { order_id: draft.id, payment_collection_id: collection.id } })
      await createOrderFulfillmentWorkflow(container).run({ input: {
        order_id: draft.id, items: draft.items!.map(item => ({ id: item.id, quantity: Number(item.quantity) })),
        location_id: data.berlinId, shipping_option_id: data.berlinShippingOptionId, no_notification: true,
      } })
      await container.resolve(Modules.ORDER).updateOrders(draft.id, { metadata: { ...draft.metadata, tally_stock_take_back_started: true } })
      const marked = await container.resolve(Modules.ORDER).retrieveOrder(draft.id)
      expect(marked.metadata!.tally_stock_take_back_started).toBe(true)
      expect(marked.metadata!.tally_stock_topups_reversed).toBeUndefined()
      await expectStock(data.inventoryC, 0)
      const order = await readOrder(await runOrderCreate(container, sale))
      expect(order.id).toBe(draft.id)
      expect(order.metadata!.tally_stock_take_back_started).toBe(true)
      expect(order.metadata!.tally_stock_topups_reversed).toBe(true)
      await expectStock(data.inventoryC, Number(before.stocked_quantity) - quantity + 1)
    })

    it('resumes past a canceled payment collection', async () => {
      const sale = command()
      const draft = await createDraft(sale)
      await convertDraftOrderWorkflow(container).run({ input: { id: draft.id } })
      const { result: [collection] } = await createOrderPaymentCollectionWorkflow(container).run({ input: { order_id: draft.id, amount: 10 } })
      await container.resolve(Modules.PAYMENT).updatePaymentCollections(collection.id, { status: 'canceled' })
      expect(await runOrderCreate(container, sale)).toMatchObject({ status: 'applied', serverRefs: { orderId: draft.id } })
      const { data: [order] } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({
        entity: 'order', filters: { id: draft.id }, fields: ['id', 'status', 'payment_collections.status'],
      })
      expect(order.status).toBe('completed')
      expect(order.payment_collections.map(collection => collection.status).sort()).toEqual(['canceled', 'completed'])
      const { result: detail } = await getOrderDetailWorkflow(container).run({
        input: { order_id: draft.id, fields: ['payment_status', 'currency_code'] },
      })
      expect(detail.payment_status).toBe('captured')
    })

    it.each(['draft', 'session-created', 'authorized', 'paid', 'taken-back'])('resumes a short sale after a crash at %s', async stage => {
      const sale = shortSale()
      const draft = await createDraft(sale, 1)
      if (stage !== 'draft') {
        await convertDraftOrderWorkflow(container).run({ input: { id: draft.id } })
        const { result: [collection] } = await createOrderPaymentCollectionWorkflow(container).run({
          input: { order_id: draft.id, amount: 6 },
        })
        if (stage === 'session-created' || stage === 'authorized') {
          const { result: session } = await createPaymentSessionsWorkflow(container).run({ input: {
            payment_collection_id: collection.id, provider_id: 'pp_system_default', data: {}, context: {},
          } })
          if (stage === 'authorized') await container.resolve(Modules.PAYMENT).authorizePaymentSession(session.id, {})
        } else {
          await markPaymentCollectionAsPaid(container).run({ input: { order_id: draft.id, payment_collection_id: collection.id } })
        }
      }
      if (stage === 'taken-back') {
        await createOrderFulfillmentWorkflow(container).run({ input: {
          order_id: draft.id, items: draft.items!.map(item => ({ id: item.id, quantity: Number(item.quantity) })),
          location_id: data.berlinId, shipping_option_id: data.berlinShippingOptionId, no_notification: true,
        } })
        await takeBackStockWorkflow(container).run({ input: { orderId: draft.id } })
        await expectStock(data.inventoryC, -1)
      }
      const result = await runOrderCreate(container, sale)
      const order = await readOrder(result)
      expect(result.warnings).toEqual([{ code: 'insufficient_stock', variantId: data.variantC, quantity: 1 }])
      expect(order.id).toBe(draft.id)
      expect(order.payment_collections.map(collection => Number(collection.amount))).toEqual([6])
      expect(order.fulfillments).toHaveLength(1)
      expect(order.metadata).toMatchObject({ tally_client_id: sale.payload.clientOrderId, tally_stock_topups_reversed: true })
      expect(await ordersFor(sale.payload.clientOrderId).whereNull('deleted_at').whereNot('status', 'canceled')).toHaveLength(1)
      await expectStock(data.inventoryC, -1)
    })

    it('converts and completes the same leftover draft without top-ups', async () => {
      const sale = command()
      const draft = await createDraft(sale)
      const order = await readOrder(await runOrderCreate(container, sale))
      expect(order.id).toBe(draft.id)
      expect(await ordersFor(sale.payload.clientOrderId).whereNull('deleted_at')).toHaveLength(1)
      await expectStock(data.inventoryA, 9)
    })

    it.each(['unknown_variant', 'underpaid', 'unsupported_currency'])(
      'rejects %s without creating an order', async code => {
        const sale = command()
        if (code === 'unknown_variant') sale.payload.lines[0].variantId = 'variant_unknown'
        if (code === 'underpaid') sale.payload.payments[0].amountMinor = 999
        if (code === 'unsupported_currency') sale.payload.currency = 'USD'
        const result = await runOrderCreate(container, sale)
        expect(result).toMatchObject({ id: sale.id, status: 'rejected', error: { code } })
        expect(result.serverRefs).toBeUndefined()
        expect(await ordersFor(sale.payload.clientOrderId)).toHaveLength(0)
      }
    )

    it('compensates a fulfillment failure after payment, leaving no live order, reservations, or stock change', async () => {
      const sale = shortSale()
      await expectStock(data.inventoryC, 1)
      // A call-through spy observes the real system payment capture; no boundary is mocked.
      const capture = jest.spyOn(container.resolve(Modules.PAYMENT), 'capturePayment')
      try {
        await expect(runOrderCreate(container, sale, { shippingOptionId: 'so_missing' })).rejects.toMatchObject({
          name: 'TypeError', message: "Cannot read properties of undefined (reading 'shipping_profile_id')",
        })
        expect(capture).toHaveBeenCalledTimes(1)
      } finally {
        capture.mockRestore()
      }
      expect(await ordersFor(sale.payload.clientOrderId).whereNull('deleted_at').whereNot('status', 'canceled')).toHaveLength(0)
      await expectStock(data.inventoryC, 1)
    })
  },
})
