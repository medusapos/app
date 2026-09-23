import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { MedusaContainer } from '@medusajs/framework/types'
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import type { CommandEnvelope, OrderCreatePayload } from '@tallyui/core'
import { TALLY_LEDGER_MODULE } from '../../src/modules/tally-ledger'
import type TallyLedgerModuleService from '../../src/modules/tally-ledger/service'
import { executeOrderCreate, type ExecuteOutcome } from '../../src/workflows/tally-order-create'
import { seed } from './seed'

jest.setTimeout(180000)

medusaIntegrationTestRunner({
  cwd: path.resolve(__dirname, '../app'),
  hooks: {
    beforeServerStart: async container => {
      container.resolve(ContainerRegistrationKeys.CONFIG_MODULE).modules![TALLY_LEDGER_MODULE] = {
        resolve: path.resolve(__dirname, '../../src/modules/tally-ledger'),
      }
    },
  },
  testSuite: ({ getContainer }) => {
    let container: MedusaContainer
    let ledger: TallyLedgerModuleService
    let data: Awaited<ReturnType<typeof seed>>
    beforeAll(async () => {
      container = getContainer()
      ledger = container.resolve(TALLY_LEDGER_MODULE)
      data = await seed(container)
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

    function result(outcome: ExecuteOutcome) {
      expect(outcome.kind).toBe('result')
      if (outcome.kind !== 'result') throw new Error(`Expected result, received ${JSON.stringify(outcome)}`)
      return outcome.result
    }

    function liveOrders(clientOrderId: string) {
      return container.resolve(ContainerRegistrationKeys.PG_CONNECTION)('order')
        .whereRaw("metadata->>'tally_client_id' = ?", [clientOrderId])
        .whereNull('deleted_at').whereNot('status', 'canceled')
    }

    function shortSale() {
      return command({
        lines: [{ clientLineId: randomUUID(), variantId: data.variantC, quantity: 2, unitPriceMinor: 300 }],
        subtotalMinor: 504, taxMinor: 96, totalMinor: 600,
        payments: [{ clientPaymentId: randomUUID(), method: 'cash', amountMinor: 600 }],
      })
    }

    it('stores an applied result and replays its references and warnings as a duplicate', async () => {
      const sale = shortSale()
      const first = result(await executeOrderCreate(container, sale))
      expect(first).toMatchObject({ id: sale.id, status: 'applied', warnings: [
        { code: 'insufficient_stock', variantId: data.variantC, quantity: 1 },
      ] })
      expect(await ledger.retrieveTallyCommand(sale.id)).toMatchObject({ status: 'applied', result: first })
      expect(result(await executeOrderCreate(container, sale))).toEqual({ ...first, status: 'duplicate' })
    })

    it('rejects reuse of an id with a changed payload without altering its stored result', async () => {
      const sale = command()
      const first = result(await executeOrderCreate(container, sale))
      expect(first.status).toBe('applied')
      const changed = { ...sale, payload: { ...sale.payload, totalMinor: 999 } }
      expect(result(await executeOrderCreate(container, changed))).toEqual({
        id: sale.id, status: 'rejected', error: {
          code: 'idempotency_mismatch', message: `Command ${sale.id} was already used for a different payload.`,
        },
      })
      expect(await ledger.retrieveTallyCommand(sale.id)).toMatchObject({ status: 'applied', result: first })
    })

    it('stores an underpaid rejection and replays the same rejection', async () => {
      const sale = command()
      sale.payload.payments[0].amountMinor = 999
      const first = result(await executeOrderCreate(container, sale))
      expect(first).toMatchObject({ id: sale.id, status: 'rejected', error: { code: 'underpaid' } })
      expect(await ledger.retrieveTallyCommand(sale.id)).toMatchObject({ status: 'rejected', result: first })
      expect(result(await executeOrderCreate(container, sale))).toEqual(first)
      expect(await liveOrders(sale.payload.clientOrderId)).toHaveLength(0)
    })

    it('releases a failed completion after fulfillment and retries on the same completed order', async () => {
      const sale = command()
      const complete = jest.spyOn(ledger, 'complete').mockRejectedValueOnce(new Error('Completion failed'))
      expect(await executeOrderCreate(container, sale)).toEqual({ kind: 'transient', id: sale.id, message: 'Completion failed' })
      expect(complete).toHaveBeenCalledTimes(1)
      expect(await ledger.listTallyCommands({ id: sale.id }, { withDeleted: true })).toHaveLength(0)
      const orders = await liveOrders(sale.payload.clientOrderId)
      expect(orders).toHaveLength(1)
      expect(orders[0].status).toBe('completed')
      const retried = result(await executeOrderCreate(container, sale))
      expect(retried).toMatchObject({ id: sale.id, status: 'applied', serverRefs: { orderId: orders[0].id } })
      expect(await liveOrders(sale.payload.clientOrderId)).toHaveLength(1)
      expect(await ledger.retrieveTallyCommand(sale.id)).toMatchObject({ status: 'applied', result: retried })
    })

    it('releases a failed run after real payment and leaves no live order', async () => {
      const sale = shortSale()
      const capture = jest.spyOn(container.resolve(Modules.PAYMENT), 'capturePayment')
      expect(await executeOrderCreate(container, sale, { shippingOptionId: 'so_missing' })).toEqual({
        kind: 'transient', id: sale.id, message: "Cannot read properties of undefined (reading 'shipping_profile_id')",
      })
      expect(capture).toHaveBeenCalledTimes(1)
      expect(await ledger.listTallyCommands({ id: sale.id }, { withDeleted: true })).toHaveLength(0)
      expect(await liveOrders(sale.payload.clientOrderId)).toHaveLength(0)
    })

    it('serializes concurrent command ids for one sale and deduplicates the retry', async () => {
      const first = command()
      const sales = [first, { ...first, id: randomUUID() }]
      const outcomes = await Promise.all(sales.map(sale => executeOrderCreate(container, sale)))
      expect(outcomes.filter(outcome => outcome.kind === 'result')).toHaveLength(1)
      expect(outcomes.filter(outcome => outcome.kind === 'in_progress')).toHaveLength(1)
      const applied = result(outcomes.find(outcome => outcome.kind === 'result')!)
      expect(applied.status).toBe('applied')
      expect(await liveOrders(first.payload.clientOrderId)).toHaveLength(1)
      const waiting = sales[outcomes.findIndex(outcome => outcome.kind === 'in_progress')]
      expect(await ledger.listTallyCommands({ id: waiting.id })).toHaveLength(0)
      const retried = result(await executeOrderCreate(container, waiting))
      expect(retried).toEqual({ ...applied, id: waiting.id })
      expect(await liveOrders(first.payload.clientOrderId)).toHaveLength(1)
      for (const sale of sales) {
        expect(await ledger.retrieveTallyCommand(sale.id)).toMatchObject({
          status: 'applied', result: { id: sale.id, status: 'applied', serverRefs: applied.serverRefs },
        })
      }
    })

    it('releases its claim when another connection holds the sale lock and succeeds after unlock', async () => {
      const sale = command()
      const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
      const connection = await knex.client.acquireConnection()
      try {
        const { rows: [{ locked }] } = await connection.query(
          "select pg_try_advisory_lock(hashtext('tally_order'), hashtext($1)) as locked", [sale.payload.clientOrderId]
        )
        expect(locked).toBe(true)
        expect(await executeOrderCreate(container, sale)).toEqual({ kind: 'in_progress', id: sale.id })
        expect(await ledger.listTallyCommands({ id: sale.id }, { withDeleted: true })).toHaveLength(0)
        expect(await liveOrders(sale.payload.clientOrderId)).toHaveLength(0)
      } finally {
        try {
          await connection.query(
            "select pg_advisory_unlock(hashtext('tally_order'), hashtext($1))", [sale.payload.clientOrderId]
          )
        } finally {
          await knex.client.releaseConnection(connection)
        }
      }
      expect(result(await executeOrderCreate(container, sale)).status).toBe('applied')
      expect(await liveOrders(sale.payload.clientOrderId)).toHaveLength(1)
    })
  },
})
