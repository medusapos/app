import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { MedusaContainer } from '@medusajs/framework/types'
import { WorkflowManager } from '@medusajs/framework/orchestration'
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import {
  cancelOrderWorkflow, convertDraftOrderWorkflow, createOrderPaymentCollectionWorkflow, createOrderWorkflow, markPaymentCollectionAsPaid,
  type CreateOrderWorkflowInput,
} from '@medusajs/medusa/core-flows'
import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import type { CommandEnvelope, OrderCreatePayload } from '@tallyui/core' with { 'resolution-mode': 'import' }
import { TALLY_LEDGER_MODULE } from '../../src/modules/tally-ledger'
import type TallyLedgerModuleService from '../../src/modules/tally-ledger/service'
import { commandFingerprint } from '../../src/workflows/tally-order-create/fingerprint'
import type { OrderCreatePayloadV3 } from '../../src/workflows/tally-order-create/fiscal-figures'
import { planOrderCreate } from '../../src/workflows/tally-order-create/plan'
import { seed } from './seed'

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

    function liveOrders(clientOrderId: string) {
      return container.resolve(ContainerRegistrationKeys.PG_CONNECTION)('order')
        .whereRaw("metadata->>'tally_client_id' = ?", [clientOrderId])
        .whereNull('deleted_at').whereNot('status', 'canceled')
    }

    async function levelC(inventoryItemId = data.inventoryC) {
      const [level] = await container.resolve(Modules.INVENTORY).listInventoryLevels({ inventory_item_id: inventoryItemId, location_id: data.berlinId })
      return [Number(level.stocked_quantity), Number(level.reserved_quantity)]
    }
    const levelA = () => levelC(data.inventoryA)

    // The real order write commits, then throws once for the first write that sets each metadata key; returns the keys fired.
    function probeOrderWrites(...keys: string[]) {
      const orders = container.resolve(Modules.ORDER)
      const update = orders.updateOrders.bind(orders) as (...args: unknown[]) => Promise<unknown>
      const fired: string[] = []
      jest.spyOn(orders, 'updateOrders').mockImplementation((async (...args: unknown[]) => {
        const result = await update(...args)
        const metadata = (args[1] as { metadata?: Record<string, unknown> } | undefined)?.metadata ?? {}
        const key = keys.find(key => metadata[key] && !fired.includes(key))
        if (!key) return result
        fired.push(key)
        throw new Error(`${key} probe`)
      }) as never)
      return fired
    }

    it('requires admin authentication and protocol 1', async () => {
      const sale = command()
      expect((await post([sale], { 'X-Tally-Protocol': '1' })).status).toBe(401)
      const invalidHeaders: Record<string, string>[] = [
        { Authorization: headers.Authorization }, { ...headers, 'X-Tally-Protocol': '2' },
      ]
      for (const requestHeaders of invalidHeaders) {
        const response = await post([sale], requestHeaders)
        expect(response.status).toBe(400)
        expect(response.data).toEqual({ code: 'unsupported_protocol' })
      }
      expect(await ledger.listTallyCommands({ id: sale.id })).toHaveLength(0)
    })

    it('answers unauthenticated preflights with CORS only for adminCors origins', async () => {
      for (const origin of ['http://localhost', 'https://untrusted.example']) {
        const response = await api.options('/tally/v1/commands', { headers: {
          Origin: origin, 'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'authorization,content-type,x-tally-protocol',
        } })
        expect(response.status).toBe(204)
        if (origin === 'http://localhost') {
          expect(response.headers['access-control-allow-origin']).toBe(origin)
          expect(response.headers['access-control-allow-credentials']).toBe('true')
          expect(response.headers['access-control-allow-headers'].toLowerCase().split(',')).toEqual([
            'authorization', 'content-type', 'x-tally-protocol',
          ])
          expect(response.headers['access-control-allow-methods'].split(',')).toEqual(['POST', 'OPTIONS'])
        } else {
          expect(response.headers['access-control-allow-origin']).toBeUndefined()
        }
      }
    })

    it('serves GET /tally/v1/info to bearer and session users, 401 otherwise, with CORS for adminCors origins (ADR-062)', async () => {
      const info = (requestHeaders: Record<string, string>) =>
        api.get('/tally/v1/info', { headers: requestHeaders, validateStatus: () => true })
      const session = await api.post('/auth/session', {}, { headers: { Authorization: headers.Authorization } })
      const cookie = session.headers['set-cookie']![0].split(';')[0]
      for (const requestHeaders of [{ Authorization: headers.Authorization }, { Cookie: cookie }] as Record<string, string>[]) {
        const response = await info(requestHeaders)
        expect([response.status, response.data]).toEqual([200, { contracts: { 'order.create': [1, 2, 3], register: [1], sync: [1] } }])
      }
      expect((await info({})).status).toBe(401)
      for (const origin of ['http://localhost', 'https://untrusted.example']) {
        const response = await api.options('/tally/v1/info', { headers: {
          Origin: origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization',
        } })
        expect(response.status).toBe(204)
        expect(response.headers['access-control-allow-origin']).toBe(origin === 'http://localhost' ? origin : undefined)
        if (origin === 'http://localhost') expect(response.headers['access-control-allow-methods']).toBe('GET,OPTIONS')
      }
    })

    it('/info lists order.create versions 1, 2 and 3', async () => {
      const response = await api.get('/tally/v1/info', { headers })
      expect(response.status).toBe(200)
      expect(response.data).toEqual({ contracts: { 'order.create': [1, 2, 3], register: [1], sync: [1] } })
    })

    it('a batch with a version-4 command and a version-1 command rejects only the first, as unsupported_version, and applies the second', async () => {
      const unsupported = { ...command(), version: 4 }
      const supported = command()
      const response = await post([unsupported, supported])
      expect(response.status).toBe(200)
      expect(response.data.results).toEqual([
        { id: unsupported.id, status: 'rejected', error: { code: 'unsupported_version',
          message: 'order.create version 4 is not supported; this server supports 1, 2, 3', data: { orderCreate: 3 } } },
        expect.objectContaining({ id: supported.id, status: 'applied' }),
      ])
      expect(await ledger.listTallyCommands({ id: unsupported.id })).toHaveLength(0)
      expect(await liveOrders(unsupported.payload.clientOrderId)).toHaveLength(0)
      expect(await liveOrders(supported.payload.clientOrderId)).toHaveLength(1)
    })

    it('a command rejected as unsupported_version was never recorded: resending its id at a supported version is applied, not a duplicate or mismatch', async () => {
      const sale = command()
      const unsupported = await post([{ ...sale, version: 4 }])
      expect(unsupported.status).toBe(200)
      expect(unsupported.data.results).toEqual([{ id: sale.id, status: 'rejected', error: {
        code: 'unsupported_version', message: 'order.create version 4 is not supported; this server supports 1, 2, 3',
        data: { orderCreate: 3 },
      } }])
      const supported = await post([sale])
      expect(supported.status).toBe(200)
      expect(supported.data.results).toEqual([expect.objectContaining({ id: sale.id, status: 'applied' })])
      const replay = await post([sale])
      expect(replay.status).toBe(200)
      expect(replay.data.results).toEqual([expect.objectContaining({ id: sale.id, status: 'duplicate' })])
    })

    // 19% inclusive: 1000 − 100 = 900 gross (net 756, tax 144); and 1000 − 1000 = 0, which has no payment collection.
    it.each([[100, 756, 144, 900], [1000, 0, 0, 0]])('replays a v2 sale discounted by %i as duplicate twice, with one order and one adjustment',
      async (discountMinor, subtotalMinor, taxMinor, totalMinor) => {
        const sale = { ...command({
          discountMinor, subtotalMinor, taxMinor, totalMinor,
          lines: [{ clientLineId: randomUUID(), variantId: data.variantB, quantity: 1, unitPriceMinor: 1000, discountMinor }],
          payments: [{ clientPaymentId: randomUUID(), method: 'cash', amountMinor: totalMinor }],
        }), version: 2 as const }
        const responses = [await post([sale]), await post([sale]), await post([sale])]
        expect(responses.map(response => [response.status, response.data.results[0].status])).toEqual([
          [200, 'applied'], [200, 'duplicate'], [200, 'duplicate'],
        ])
        expect(responses[0].data.results[0]).toMatchObject({ serverRefs: { totalMinor } })
        expect(responses[0].data.results[0].warnings).toBeUndefined()
        const orders = await liveOrders(sale.payload.clientOrderId)
        expect(orders).toHaveLength(1)
        // Medusa copies an item's adjustments into each order version (fulfilment bumps the version), so
        // count per version: exactly one adjustment in every version, the current one included.
        const { data: [order] } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({
          entity: 'order', filters: { id: orders[0].id }, fields: ['items.id'],
        })
        expect(order.items).toHaveLength(1)
        const rows = await container.resolve(ContainerRegistrationKeys.PG_CONNECTION)('order_line_item_adjustment')
          .where('item_id', order.items[0].id).whereNull('deleted_at')
        expect(new Set(rows.map(row => row.version)).size).toBe(rows.length)
        expect(rows.map(row => row.version)).toContain(orders[0].version)
        expect(rows.map(row => [Number(row.amount), row.description])).toEqual(rows.map(() => [discountMinor / 100, 'POS discount']))
      })

    it('applies two sales in order and replays the original references and warnings exactly once', async () => {
      const sales = [command(), command({
        lines: [{ clientLineId: randomUUID(), variantId: data.variantC, quantity: 2, unitPriceMinor: 300 }],
        subtotalMinor: 504, taxMinor: 96, totalMinor: 600,
        payments: [{ clientPaymentId: randomUUID(), method: 'cash', amountMinor: 600 }],
      })]
      const first = await post(sales)
      expect(first.status).toBe(200)
      expect(first.data.results).toHaveLength(2)
      expect(first.data.results.map(result => [result.id, result.status])).toEqual(sales.map(sale => [sale.id, 'applied']))
      expect(first.data.results[1].warnings).toEqual([
        { code: 'insufficient_stock', variantId: data.variantC, quantity: 1 },
      ])
      for (const [index, sale] of sales.entries()) {
        const { data: [order] } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({
          entity: 'order', filters: { id: first.data.results[index].serverRefs.orderId },
          fields: ['id', 'status', 'metadata', 'payment_collections.amount', 'payment_collections.status'],
        })
        expect(order.status).toBe('completed')
        expect(order.metadata.tally_client_id).toBe(sale.payload.clientOrderId)
        expect(order.payment_collections.map(collection => [Number(collection.amount), collection.status]))
          .toEqual([[sale.payload.totalMinor / 100, 'completed']])
      }
      const replay = await post(sales)
      expect(replay.status).toBe(200)
      expect(replay.data.results).toEqual(first.data.results.map(result => ({ ...result, status: 'duplicate' })))
      for (const sale of sales) expect(await liveOrders(sale.payload.clientOrderId)).toHaveLength(1)
    })

    it('carries a top-up applied before a crash', async () => {
      const inventory = container.resolve(Modules.INVENTORY)
      const [before] = await inventory.listInventoryLevels({ inventory_item_id: data.inventoryC, location_id: data.berlinId })
      const quantity = Number(before.stocked_quantity) + 1
      const sale = command({
        lines: [{ clientLineId: randomUUID(), variantId: data.variantC, quantity, unitPriceMinor: 300 }],
        subtotalMinor: 252 * quantity, taxMinor: 48 * quantity, totalMinor: 300 * quantity,
        payments: [{ clientPaymentId: randomUUID(), method: 'cash', amountMinor: 300 * quantity }],
      })
      const claim = await ledger.claim({ id: sale.id, type: sale.type, fingerprint: commandFingerprint(sale) })
      if (!claim.claimed) throw new Error('Expected a fresh claim')
      const topUps = [{ inventory_item_id: data.inventoryC, location_id: data.berlinId, shortfall: 1 }]
      await inventory.adjustInventory(data.inventoryC, data.berlinId, 1)
      await ledger.recordStockTopUps(sale.id, claim.claimToken, topUps, null)
      await ledger.release(sale.id, claim.claimToken)
      const response = await post([sale])
      expect(response.status).toBe(200)
      expect(response.data.results).toEqual([expect.objectContaining({
        id: sale.id, status: 'applied',
        warnings: [{ code: 'insufficient_stock', variantId: data.variantC, quantity: 1 }],
      })])
      const orders = await liveOrders(sale.payload.clientOrderId)
      expect(orders).toHaveLength(1)
      expect(orders[0].metadata.tally_stock_topups).toEqual(topUps)
      const [level] = await inventory.listInventoryLevels({ inventory_item_id: data.inventoryC, location_id: data.berlinId })
      expect(Number(level.stocked_quantity)).toBe(-1)
      expect(Number(level.reserved_quantity)).toBe(0)
    })

    it('restores the ledger after an applied top-up even if the claim token changed', async () => {
      const run = require('../../.medusa/server/src/workflows/tally-order-create/run') as typeof import('../../src/workflows/tally-order-create/run')
      const inventory = container.resolve(Modules.INVENTORY)
      const [before] = await inventory.listInventoryLevels({ inventory_item_id: data.inventoryC, location_id: data.berlinId })
      const quantity = Number(before.stocked_quantity) + 1
      const sale = command({
        lines: [{ clientLineId: randomUUID(), variantId: data.variantC, quantity, unitPriceMinor: 300 }],
        subtotalMinor: 252 * quantity, taxMinor: 48 * quantity, totalMinor: 300 * quantity,
        payments: [{ clientPaymentId: randomUUID(), method: 'cash', amountMinor: 300 * quantity }],
      })
      const claim = await ledger.claim({ id: sale.id, type: sale.type, fingerprint: commandFingerprint(sale) })
      if (!claim.claimed) throw new Error('Expected a fresh claim')
      const nextToken = randomUUID()
      const record = ledger.recordStockTopUps.bind(ledger)
      // Write through to the real ledger, then simulate a lease reclaim after the applied write.
      jest.spyOn(ledger, 'recordStockTopUps').mockImplementation(async (...args) => {
        const written = await record(...args)
        if (written && args[2].length && args[3] === null) {
          await container.resolve(ContainerRegistrationKeys.PG_CONNECTION)('tally_command')
            .where({ id: sale.id }).update({ claim_token: nextToken })
        }
        return written
      })
      await expect(run.runOrderCreate(container, sale, { shippingOptionId: 'so_missing' }, {
        claimToken: claim.claimToken, carriedTopUps: [],
      })).rejects.toMatchObject({
        name: 'TypeError', message: "Cannot read properties of undefined (reading 'shipping_profile_id')",
      })
      expect(await ledger.retrieveTallyCommand(sale.id)).toMatchObject({
        status: 'in_progress', claim_token: nextToken, stock_topups_applied: null, stock_topups_pending: null,
      })
      const [after] = await inventory.listInventoryLevels({ inventory_item_id: data.inventoryC, location_id: data.berlinId })
      expect(Number(after.stocked_quantity)).toBe(Number(before.stocked_quantity))
      expect(Number(after.reserved_quantity)).toBe(Number(before.reserved_quantity))
    })

    it('carries an applied top-up and adds a new shortfall through the endpoint', async () => {
      const inventory = container.resolve(Modules.INVENTORY)
      const [before] = await inventory.listInventoryLevels({ inventory_item_id: data.inventoryC, location_id: data.berlinId })
      const quantity = Number(before.stocked_quantity) + 2
      const sale = command({
        lines: [{ clientLineId: randomUUID(), variantId: data.variantC, quantity, unitPriceMinor: 300 }],
        subtotalMinor: 252 * quantity, taxMinor: 48 * quantity, totalMinor: 300 * quantity,
        payments: [{ clientPaymentId: randomUUID(), method: 'cash', amountMinor: 300 * quantity }],
      })
      const claim = await ledger.claim({ id: sale.id, type: sale.type, fingerprint: commandFingerprint(sale) })
      if (!claim.claimed) throw new Error('Expected a fresh claim')
      const topUps = [{ inventory_item_id: data.inventoryC, location_id: data.berlinId, shortfall: 1 }]
      await inventory.adjustInventory(data.inventoryC, data.berlinId, 1)
      expect(await ledger.recordStockTopUps(sale.id, claim.claimToken, topUps, null)).toBe(true)
      await ledger.release(sale.id, claim.claimToken)
      const response = await post([sale])
      expect(response.status).toBe(200)
      expect(response.data.results).toEqual([expect.objectContaining({
        id: sale.id, status: 'applied',
        warnings: [{ code: 'insufficient_stock', variantId: data.variantC, quantity: 2 }],
      })])
      const orders = await liveOrders(sale.payload.clientOrderId)
      expect(orders).toHaveLength(1)
      expect(orders[0].metadata.tally_stock_topups).toEqual([{ ...topUps[0], shortfall: 2 }])
      const [after] = await inventory.listInventoryLevels({ inventory_item_id: data.inventoryC, location_id: data.berlinId })
      expect(Number(after.stocked_quantity)).toBe(-2)
      expect(Number(after.reserved_quantity)).toBe(0)
    })

    it('keeps the applied top-ups on the completed ledger row after a short sale', async () => {
      const inventory = container.resolve(Modules.INVENTORY)
      const [before] = await inventory.listInventoryLevels({ inventory_item_id: data.inventoryC, location_id: data.berlinId })
      const quantity = Number(before.stocked_quantity) + 1
      const sale = command({
        lines: [{ clientLineId: randomUUID(), variantId: data.variantC, quantity, unitPriceMinor: 300 }],
        subtotalMinor: 252 * quantity, taxMinor: 48 * quantity, totalMinor: 300 * quantity,
        payments: [{ clientPaymentId: randomUUID(), method: 'cash', amountMinor: 300 * quantity }],
      })
      const response = await post([sale])
      expect(response.status).toBe(200)
      expect(response.data.results[0]).toMatchObject({ id: sale.id, status: 'applied' })
      const orders = await liveOrders(sale.payload.clientOrderId)
      expect(orders).toHaveLength(1)
      expect(orders[0].metadata.tally_stock_topups).toEqual([
        { inventory_item_id: data.inventoryC, location_id: data.berlinId, shortfall: 1 },
      ])
      expect(await ledger.retrieveTallyCommand(sale.id)).toMatchObject({
        status: 'applied', stock_topups_applied: orders[0].metadata.tally_stock_topups, stock_topups_pending: null,
      })
    })

    it('a short sale whose take-back unlock throws is applied and takes its top-up back exactly once', async () => {
      const inventory = container.resolve(Modules.INVENTORY)
      const [before] = await inventory.listInventoryLevels({ inventory_item_id: data.inventoryC, location_id: data.berlinId })
      const quantity = Math.max(Number(before.stocked_quantity) - Number(before.reserved_quantity), 0) + 1
      const sale = command({
        lines: [{ clientLineId: randomUUID(), variantId: data.variantC, quantity, unitPriceMinor: 300 }],
        subtotalMinor: 252 * quantity, taxMinor: 48 * quantity, totalMinor: 300 * quantity,
        payments: [{ clientPaymentId: randomUUID(), method: 'cash', amountMinor: 300 * quantity }],
      })
      const locking = container.resolve(Modules.LOCKING)
      const execute = locking.execute.bind(locking) as (...args: unknown[]) => Promise<unknown>
      let probes = 0
      // Only the take-back's execute runs after it marks the order started; that one throws after its job.
      jest.spyOn(locking, 'execute').mockImplementation((async (...args: unknown[]) => {
        const result = await execute(...args)
        const [order] = await liveOrders(sale.payload.clientOrderId)
        if (probes || order?.metadata?.tally_stock_take_back_started !== true) return result
        probes++
        throw new Error('unlock probe')
      }) as never)
      const log = jest.spyOn(container.resolve(ContainerRegistrationKeys.LOGGER), 'error')
      const response = await post([sale])
      const [after] = await inventory.listInventoryLevels({ inventory_item_id: data.inventoryC, location_id: data.berlinId })
      expect([Number(after.stocked_quantity), Number(after.reserved_quantity)])
        .toEqual([Number(before.stocked_quantity) - quantity, Number(before.reserved_quantity)])
      expect([response.status, response.data.results[0].status, probes]).toEqual([200, 'applied', 1])
      const [order] = await liveOrders(sale.payload.clientOrderId)
      expect(order.metadata).toMatchObject({ tally_stock_take_back_started: true, tally_stock_topups_reversed: true })
      expect(log).toHaveBeenCalledWith(expect.stringContaining(`order ${order.id} took its stock top-up back, but the lock release failed: unlock probe`))
      await inventory.adjustInventory(data.inventoryC, data.berlinId, quantity)
    })

    it('a short sale whose take-back marker write throws after its adjustment fails cleanly with its top-up and take-back each reversed once, and the retry takes it back once', async () => {
      const before = await levelC()
      const quantity = Math.max(before[0] - before[1], 0) + 1
      const sale = command({
        lines: [{ clientLineId: randomUUID(), variantId: data.variantC, quantity, unitPriceMinor: 300 }],
        subtotalMinor: 252 * quantity, taxMinor: 48 * quantity, totalMinor: 300 * quantity,
        payments: [{ clientPaymentId: randomUUID(), method: 'cash', amountMinor: 300 * quantity }],
      })
      const fired = probeOrderWrites('tally_stock_topups_reversed')
      const log = jest.spyOn(container.resolve(ContainerRegistrationKeys.LOGGER), 'error')
      expect((await post([sale])).status).toBe(503)
      // Medusa ran the take-back's compensation with its data, the fulfilment's, then reversed the top-up: each exactly once.
      expect([await levelC(), fired]).toEqual([before, ['tally_stock_topups_reversed']])
      expect(log).toHaveBeenCalledWith(expect.stringContaining('took its stock top-up back, but the reversed marker write failed: tally_stock_topups_reversed probe'))
      expect(await liveOrders(sale.payload.clientOrderId)).toHaveLength(0)
      const response = await post([sale])
      expect([response.status, response.data.results[0].status]).toEqual([200, 'applied'])
      expect(await levelC()).toEqual([before[0] - quantity, before[1]])
      await container.resolve(Modules.INVENTORY).adjustInventory(data.inventoryC, data.berlinId, quantity)
    })

    it('a sale that fails at completeOrderWorkflow puts its fulfilled stock back exactly, and the retry takes it once', async () => {
      const before = await levelC()
      const quantity = 1
      const sale = command({
        lines: [{ clientLineId: randomUUID(), variantId: data.variantC, quantity, unitPriceMinor: 300 }],
        subtotalMinor: 252, taxMinor: 48, totalMinor: 300,
        payments: [{ clientPaymentId: randomUUID(), method: 'cash', amountMinor: 300 }],
      })
      jest.spyOn(container.resolve(Modules.ORDER), 'completeOrder').mockRejectedValueOnce(new Error('complete probe'))
      expect((await post([sale])).status).toBe(503)
      expect([await levelC(), await liveOrders(sale.payload.clientOrderId)]).toEqual([before, []])
      const response = await post([sale])
      expect([response.status, response.data.results[0].status]).toEqual([200, 'applied'])
      expect(await levelC()).toEqual([before[0] - quantity, before[1]])
      await container.resolve(Modules.INVENTORY).adjustInventory(data.inventoryC, data.berlinId, quantity)
    })

    it.each(['the second fulfilment group', 'completeOrderWorkflow'])('a two-group sale that fails at %s puts every fulfilled group\'s stock back exactly', async failure => {
      const before = [await levelC(), await levelA()]
      // A shipped line of C and, overridden to not require shipping, a line of A: two fulfilment groups.
      const plan = require('../../.medusa/server/src/workflows/tally-order-create/plan') as typeof import('../../src/workflows/tally-order-create/plan')
      const planOrderCreate = plan.planOrderCreate
      jest.spyOn(plan, 'planOrderCreate').mockImplementation((...args) => {
        const planned = planOrderCreate(...args)
        if (planned.ok) Object.assign(planned.plan.draftOrder.items.find(item => item.variant_id === data.variantA)!, { requires_shipping: false })
        return planned
      })
      const orders = container.resolve(Modules.ORDER)
      const registerFulfillment = orders.registerFulfillment.bind(orders)
      const register = jest.spyOn(orders, 'registerFulfillment').mockImplementationOnce(registerFulfillment)
      if (failure === 'completeOrderWorkflow') jest.spyOn(orders, 'completeOrder').mockRejectedValueOnce(new Error('complete probe'))
      else register.mockRejectedValueOnce(new Error('second group probe'))
      const sale = command({
        lines: [
          { clientLineId: randomUUID(), variantId: data.variantC, quantity: 1, unitPriceMinor: 300 },
          { clientLineId: randomUUID(), variantId: data.variantA, quantity: 1, unitPriceMinor: 1000 },
        ],
        subtotalMinor: 1092, taxMinor: 208, totalMinor: 1300,
        payments: [{ clientPaymentId: randomUUID(), method: 'cash', amountMinor: 1300 }],
      })
      expect((await post([sale])).status).toBe(503)
      expect(register).toHaveBeenCalledTimes(2)
      expect([await levelC(), await levelA(), await liveOrders(sale.payload.clientOrderId)]).toEqual([...before, []])
    })

    it('ignores a pending top-up whose outcome is unknown', async () => {
      const inventory = container.resolve(Modules.INVENTORY)
      const [before] = await inventory.listInventoryLevels({ inventory_item_id: data.inventoryC, location_id: data.berlinId })
      const quantity = Number(before.stocked_quantity) + 1
      const sale = command({
        lines: [{ clientLineId: randomUUID(), variantId: data.variantC, quantity, unitPriceMinor: 300 }],
        subtotalMinor: 252 * quantity, taxMinor: 48 * quantity, totalMinor: 300 * quantity,
        payments: [{ clientPaymentId: randomUUID(), method: 'cash', amountMinor: 300 * quantity }],
      })
      const claim = await ledger.claim({ id: sale.id, type: sale.type, fingerprint: commandFingerprint(sale) })
      if (!claim.claimed) throw new Error('Expected a fresh claim')
      const pending = [{ inventory_item_id: data.inventoryC, location_id: data.berlinId, shortfall: 1 }]
      await inventory.adjustInventory(data.inventoryC, data.berlinId, 1)
      await ledger.recordStockTopUps(sale.id, claim.claimToken, [], pending)
      await container.resolve(ContainerRegistrationKeys.PG_CONNECTION)('tally_command')
        .where({ id: sale.id }).update({ updated_at: new Date(Date.now() - 60 * 60 * 1000) })
      const response = await post([sale])
      expect(response.status).toBe(200)
      expect(response.data.results).toEqual([expect.objectContaining({ id: sale.id, status: 'applied' })])
      const [level] = await inventory.listInventoryLevels({ inventory_item_id: data.inventoryC, location_id: data.berlinId })
      expect(Number(level.stocked_quantity)).toBe(0)
      expect((await ledger.retrieveTallyCommand(sale.id)).stock_topups_pending).toEqual(pending)
    })

    it('rejects reuse of an id with a changed payload', async () => {
      const sale = command()
      expect((await post([sale])).data.results[0].status).toBe('applied')
      const response = await post([{ ...sale, payload: { ...sale.payload, totalMinor: 999 } }])
      expect(response.status).toBe(200)
      expect(response.data.results).toEqual([expect.objectContaining({
        id: sale.id, status: 'rejected', error: expect.objectContaining({ code: 'idempotency_mismatch' }),
      })])
      expect(await liveOrders(sale.payload.clientOrderId)).toHaveLength(1)
    })

    it('applies the first sale and persists an underpaid rejection on replay', async () => {
      const sales = [command(), command()]
      sales[1].payload.payments[0].amountMinor = 999
      const first = await post(sales)
      expect(first.status).toBe(200)
      expect(first.data.results).toEqual([
        expect.objectContaining({ id: sales[0].id, status: 'applied' }),
        expect.objectContaining({ id: sales[1].id, status: 'rejected', error: expect.objectContaining({ code: 'underpaid' }) }),
      ])
      const replay = await post(sales)
      expect(replay.status).toBe(200)
      expect(replay.data.results).toEqual([{ ...first.data.results[0], status: 'duplicate' }, first.data.results[1]])
      expect(await liveOrders(sales[1].payload.clientOrderId)).toHaveLength(0)
    })

    it('rejects an invalid payload without storing it and continues the batch on replay', async () => {
      const malformed = command()
      const { lines, ...payload } = malformed.payload
      const sales = [{ ...malformed, payload }, command()]
      const first = await post(sales)
      expect(first.status).toBe(200)
      expect(first.data.results).toEqual([
        { id: malformed.id, status: 'rejected', error: {
          code: 'invalid_payload', message: expect.stringContaining('lines'),
        } },
        expect.objectContaining({ id: sales[1].id, status: 'applied' }),
      ])
      expect(await ledger.listTallyCommands({ id: malformed.id }, { withDeleted: true })).toHaveLength(0)
      const replay = await post(sales)
      expect(replay.status).toBe(200)
      expect(replay.data.results).toEqual([first.data.results[0], { ...first.data.results[1], status: 'duplicate' }])
      expect(await ledger.listTallyCommands({ id: malformed.id }, { withDeleted: true })).toHaveLength(0)
    })

    it('rejects a missing clientOrderId before claiming or taking the advisory lock', async () => {
      const malformed = command()
      const { clientOrderId, ...payload } = malformed.payload
      const response = await post([{ ...malformed, payload }])
      expect(response.status).toBe(200)
      expect(response.data.results).toEqual([{ id: malformed.id, status: 'rejected', error: {
        code: 'invalid_payload', message: expect.stringContaining('clientOrderId'),
      } }])
      expect(await ledger.listTallyCommands({ id: malformed.id }, { withDeleted: true })).toHaveLength(0)
    })

    it('stops at a fresh claim with 409 and replays the preceding sale on retry', async () => {
      const sales = [command(), command(), command()]
      const claim = await ledger.claim({ id: sales[1].id, type: sales[1].type, fingerprint: commandFingerprint(sales[1]) })
      expect(claim.claimed).toBe(true)
      const response = await post(sales)
      expect(response.status).toBe(409)
      expect(response.data).toEqual({ code: 'in_progress', id: sales[1].id })
      const preceding = await ledger.retrieveTallyCommand(sales[0].id)
      expect(preceding.status).toBe('applied')
      expect(await liveOrders(sales[0].payload.clientOrderId)).toHaveLength(1)
      expect(await ledger.listTallyCommands({ id: sales[2].id })).toHaveLength(0)
      if (!claim.claimed) throw new Error('Expected a fresh claim')
      await ledger.release(sales[1].id, claim.claimToken)
      const retry = await post(sales)
      expect(retry.status).toBe(200)
      expect(retry.data.results).toEqual([
        { ...preceding.result, status: 'duplicate' },
        expect.objectContaining({ id: sales[1].id, status: 'applied' }),
        expect.objectContaining({ id: sales[2].id, status: 'applied' }),
      ])
    })

    it('returns 503, releases the failed claim, stops the batch, and permits a retry', async () => {
      const run = require('../../.medusa/server/src/workflows/tally-order-create/run') as typeof import('../../src/workflows/tally-order-create/run')
      const original = run.runOrderCreate
      const spy = jest.spyOn(run, 'runOrderCreate').mockImplementationOnce(original)
        .mockRejectedValueOnce(new Error('Temporary workflow failure'))
      const log = jest.spyOn(container.resolve(ContainerRegistrationKeys.LOGGER), 'error')
      const sales = [command(), command(), command()]
      const response = await post(sales)
      expect(response.status).toBe(503)
      expect(response.data).toEqual({ code: 'transient', id: sales[1].id, message: 'Temporary failure, retry later.' })
      expect(JSON.stringify(response.data)).not.toContain('Temporary workflow failure')
      expect(log).toHaveBeenCalledWith(`Command ${sales[1].id} failed transiently: Temporary workflow failure`)
      expect(spy).toHaveBeenCalledTimes(2)
      expect(spy.mock.calls[1][1]).toEqual(sales[1])
      expect(spy.mock.calls[1][2]).toBe(ledger.getPluginOptions())
      expect(await ledger.listTallyCommands({ id: sales[1].id }, { withDeleted: true })).toHaveLength(0)
      expect(await liveOrders(sales[1].payload.clientOrderId)).toHaveLength(0)
      expect(await ledger.listTallyCommands({ id: sales[2].id })).toHaveLength(0)
      spy.mockRestore()
      const retry = await post(sales)
      expect(retry.status).toBe(200)
      expect(retry.data.results.map(result => [result.id, result.status])).toEqual([
        [sales[0].id, 'duplicate'], [sales[1].id, 'applied'], [sales[2].id, 'applied'],
      ])
    })

    describe('needs_admin', () => {
      const built = '../../.medusa/server/src'
      const detail = 'payment collection pay_col_admin is refunded'
      function spyRun() {
        const run = require(`${built}/workflows/tally-order-create/run`) as typeof import('../../src/workflows/tally-order-create/run')
        return jest.spyOn(run, 'runOrderCreate')
      }
      async function park() {
        const { NeedsAdminError } = require(`${built}/workflows/tally-order-create/needs-admin-error`) as
          typeof import('../../src/workflows/tally-order-create/needs-admin-error')
        const spy = spyRun().mockRejectedValueOnce(new NeedsAdminError('order_admin', detail))
        const log = jest.spyOn(container.resolve(ContainerRegistrationKeys.LOGGER), 'error')
        const sale = command()
        const response = await post([sale])
        expect([response.status, response.data]).toEqual([409, { code: 'in_progress', id: sale.id }])
        return { sale, spy, log }
      }
      async function resolve(id: string, action: string, message?: string) {
        const script = require(`${built}/scripts/tally-ledger-resolve`) as typeof import('../../src/scripts/tally-ledger-resolve')
        await script.default({ container, args: [id, action, ...message ? [message] : []] })
      }

      it('a resume refused as needs_admin answers 409, parks the row with its reason, and logs one line', async () => {
        const { sale, log } = await park()
        expect(await ledger.retrieveTallyCommand(sale.id)).toMatchObject({
          status: 'needs_admin', needs_admin_reason: { orderId: 'order_admin', clientOrderId: sale.payload.clientOrderId, detail },
        })
        expect(log.mock.calls.filter(([line]) => String(line).includes('needs admin'))).toEqual([
          [`tally order.create needs admin: command ${sale.id}, order order_admin: ${detail}`],
        ])
      })

      it('a needs_admin row past the lease is never reclaimed: the resend gets 409 without running the recipe', async () => {
        const { sale, spy } = await park()
        const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
        await knex('tally_command').where({ id: sale.id }).update({ updated_at: knex.raw("now() - interval '1 hour'") })
        const response = await post([sale])
        expect([response.status, response.data]).toEqual([409, { code: 'in_progress', id: sale.id }])
        expect(spy).toHaveBeenCalledTimes(1)
        expect(await ledger.retrieveTallyCommand(sale.id)).toMatchObject({ status: 'needs_admin' })
      })

      // A converted order whose run crashed once paid; `topUp` is the plugin's unreversed stock top-up of item C.
      async function halfWrittenOrder(sale: CommandEnvelope<OrderCreatePayload>, topUp = 0) {
        const planned = planOrderCreate(sale.payload, {
          customer: null, commandId: sale.id, salesChannelId: data.channelId,
          region: { id: data.regionId, currency_code: 'eur', country_codes: ['de', 'dk'] },
          location: { id: data.berlinId, address: { address_1: 'Alexanderplatz 1', city: 'Berlin', country_code: 'de', postal_code: '10178' } },
          variants: Object.fromEntries(sale.payload.lines.map(line => [line.variantId, { id: line.variantId }])),
        })
        if (!planned.ok) throw new Error('Expected a plan')
        if (topUp) {
          await container.resolve(Modules.INVENTORY).adjustInventory(data.inventoryC, data.berlinId, topUp)
          planned.plan.draftOrder.metadata.tally_stock_topups = [{ inventory_item_id: data.inventoryC, location_id: data.berlinId, shortfall: topUp }]
        }
        const { result: draft } = await createOrderWorkflow(container).run({ input: planned.plan.draftOrder as unknown as CreateOrderWorkflowInput })
        await convertDraftOrderWorkflow(container).run({ input: { id: draft.id } })
        const { result: [collection] } = await createOrderPaymentCollectionWorkflow(container).run({
          input: { order_id: draft.id, amount: sale.payload.totalMinor / 100 },
        })
        await markPaymentCollectionAsPaid(container).run({ input: { order_id: draft.id, payment_collection_id: collection.id } })
        return { orderId: draft.id, collectionId: collection.id }
      }

      // An admin then marks the collection partially captured: the real resume refuses it.
      async function parkLiveOrder(sale = command(), topUp = 0) {
        const { orderId, collectionId } = await halfWrittenOrder(sale, topUp)
        await container.resolve(Modules.PAYMENT).updatePaymentCollections(collectionId, { status: 'partially_captured' })
        const response = await post([sale])
        expect([response.status, response.data]).toEqual([409, { code: 'in_progress', id: sale.id }])
        expect(await ledger.retrieveTallyCommand(sale.id)).toMatchObject({ status: 'needs_admin' })
        return { sale, orderId, collectionId }
      }

      it('a claim lost while parking logs a warning, not needs admin, and neither releases nor parks the row', async () => {
        jest.spyOn(ledger, 'markNeedsAdmin').mockResolvedValueOnce(false)
        const warn = jest.spyOn(container.resolve(ContainerRegistrationKeys.LOGGER), 'warn')
        const { sale, log } = await park()
        expect(warn).toHaveBeenCalledWith(
          `tally order.create: claim lost while parking command ${sale.id} for an admin (order order_admin: ${detail})`)
        expect(log.mock.calls.filter(([line]) => String(line).includes('needs admin'))).toEqual([])
        expect(await ledger.retrieveTallyCommand(sale.id)).toMatchObject({ status: 'in_progress', needs_admin_reason: null })
      })

      // Two of item C, one of them topped up by the plugin.
      function saleOfC() {
        return command({
          lines: [{ clientLineId: randomUUID(), variantId: data.variantC, quantity: 2, unitPriceMinor: 300 }],
          subtotalMinor: 504, taxMinor: 96, totalMinor: 600,
          payments: [{ clientPaymentId: randomUUID(), method: 'cash', amountMinor: 600 }],
        })
      }

      async function expectRejectedAndReversed(sale: CommandEnvelope<OrderCreatePayload>, orderId: string) {
        const [order] = await container.resolve(ContainerRegistrationKeys.PG_CONNECTION)('order').where({ id: orderId })
        expect([order.status, order.metadata.tally_stock_topups_reversed]).toEqual(['canceled', true])
        expect(order.metadata.tally_rejected).toBe(true)
        expect(await ledger.retrieveTallyCommand(sale.id)).toMatchObject({ status: 'rejected', result: { error: { data: { orderId } } } })
      }

      it('tally-ledger-resolve reject takes back the plugin\'s unreversed stock top-up before cancelling', async () => {
        const before = await levelC()
        const sale = saleOfC()
        const { orderId } = await parkLiveOrder(sale, 1)
        expect(await levelC()).toEqual([before[0] + 1, before[1] + 2])
        await resolve(sale.id, 'reject')
        expect(await levelC()).toEqual(before)
        await expectRejectedAndReversed(sale, orderId)
      })

      it('a take-back whose adjustment throws restores its started marker, so the next reject takes the stock back', async () => {
        const before = await levelC()
        const sale = saleOfC()
        const { orderId } = await parkLiveOrder(sale, 1)
        jest.spyOn(container.resolve(Modules.INVENTORY), 'adjustInventory').mockRejectedValueOnce(new Error('adjust probe'))
        // The workflow engine rethrows a serialized error, not an Error instance.
        await expect(resolve(sale.id, 'reject')).rejects.toMatchObject({ message: 'adjust probe' })
        expect(await ledger.retrieveTallyCommand(sale.id)).toMatchObject({ status: 'needs_admin', result: null })
        expect(await levelC()).toEqual([before[0] + 1, before[1] + 2])
        await resolve(sale.id, 'reject')
        expect(await levelC()).toEqual(before)
        await expectRejectedAndReversed(sale, orderId)
      })

      it('a take-back whose unlock throws after its adjustment committed still succeeds, so the reject completes and the stock is taken back once', async () => {
        const before = await levelC()
        const sale = saleOfC()
        const { orderId } = await parkLiveOrder(sale, 1)
        const locking = container.resolve(Modules.LOCKING)
        const execute = locking.execute.bind(locking) as (...args: unknown[]) => Promise<unknown>
        jest.spyOn(locking, 'execute').mockImplementationOnce((async (...args: unknown[]) => {
          await execute(...args)
          throw new Error('unlock probe')
        }) as never)
        await resolve(sale.id, 'reject')
        expect(await levelC()).toEqual(before)
        await expectRejectedAndReversed(sale, orderId)
        await expect(resolve(sale.id, 'reject')).rejects.toThrow('not needs_admin')
        expect(await levelC()).toEqual(before)
      })

      const markerProbe = { message: expect.stringContaining('the reversed marker write failed: tally_stock_topups_reversed probe') }

      it.each(['resume', 'reject'])('a take-back whose marker write throws after its adjustment on %s surfaces the error, puts the stock back, and the retry takes it back once', async path => {
        const before = await levelC()
        const sale = saleOfC()
        const { orderId } = path === 'resume' ? await halfWrittenOrder(sale, 1) : await parkLiveOrder(sale, 1)
        const fired = probeOrderWrites('tally_stock_topups_reversed')
        if (path === 'resume') expect((await post([sale])).status).toBe(503)
        else await expect(resolve(sale.id, 'reject')).rejects.toMatchObject(markerProbe)
        // The resume fulfilled both items before its take-back failed.
        expect([await levelC(), fired]).toEqual([path === 'resume' ? [before[0] - 1, before[1]] : [before[0] + 1, before[1] + 2], ['tally_stock_topups_reversed']])
        if (path === 'resume') {
          const response = await post([sale])
          expect([response.status, response.data.results[0].status]).toEqual([200, 'applied'])
          expect(await levelC()).toEqual([before[0] - 2, before[1]])
          return
        }
        await resolve(sale.id, 'reject')
        expect(await levelC()).toEqual(before)
        await expectRejectedAndReversed(sale, orderId)
      })

      it.each(['lock release', 'marker write', 'rerun lock release'])('a take-back compensation whose %s throws after its re-adjustment keeps the stock right and a second run does not re-adjust', async fault => {
        const before = await levelC()
        const sale = saleOfC()
        const { orderId } = await parkLiveOrder(sale, 1)
        const fired = probeOrderWrites('tally_stock_topups_reversed', ...fault === 'marker write' ? ['tally_stock_take_back_compensated'] : [])
        const locking = container.resolve(Modules.LOCKING)
        const execute = locking.execute.bind(locking) as (...args: unknown[]) => Promise<unknown>
        // Once the take-back's marker probe fired, the next executes are its compensation's.
        let compensationExecutes = 0
        if (fault !== 'marker write') jest.spyOn(locking, 'execute').mockImplementation((async (...args: unknown[]) => {
          const result = await execute(...args)
          if (fired.length !== 1) return result
          if (++compensationExecutes !== (fault === 'rerun lock release' ? 2 : 1)) return result
          fired.push('unlock')
          throw new Error('unlock probe')
        }) as never)
        // The real compensation runs twice with the same data, as when a crash comes before Medusa records the first run.
        const handler = WorkflowManager.getWorkflow('tally-take-back-stock').handlers_.get('tally-take-back-stock')
        const compensate = handler.compensate
        jest.spyOn(handler, 'compensate').mockImplementation(async (...args: unknown[]) => {
          await compensate(...args)
          return compensate(...args)
        })
        const log = jest.spyOn(container.resolve(ContainerRegistrationKeys.LOGGER), 'error')
        await expect(resolve(sale.id, 'reject')).rejects.toMatchObject(markerProbe)
        expect([await levelC(), fired]).toEqual([[before[0] + 1, before[1] + 2],
          ['tally_stock_topups_reversed', fault === 'marker write' ? 'tally_stock_take_back_compensated' : 'unlock']])
        expect(handler.compensate).toHaveBeenCalledTimes(1)
        expect(log).toHaveBeenCalledWith(expect.stringContaining(fault === 'rerun lock release'
          ? `tally take-back compensation: order ${orderId} restored its markers, but the lock release failed: unlock probe`
          : `tally take-back compensation: order ${orderId} put its stock top-up back`))
        await resolve(sale.id, 'reject')
        expect(await levelC()).toEqual(before)
        await expectRejectedAndReversed(sale, orderId)
      })

      it('tally-ledger-resolve destroys a connection whose unlock failed before the pool gets it back, disposed', async () => {
        const { sale } = await parkLiveOrder()
        const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
        const acquire = knex.client.acquireConnection.bind(knex.client)
        let locked: { __knex__disposed?: unknown } | undefined
        let probed = 0
        // Background work shares the pool, so the probe fails the first sale unlock on whichever connection runs it.
        jest.spyOn(knex.client, 'acquireConnection').mockImplementation(async () => {
          const connection = await acquire()
          if (jest.isMockFunction(connection.query)) return connection
          const query = connection.query.bind(connection)
          jest.spyOn(connection, 'query').mockImplementation((...args: unknown[]) => {
            if (locked || !String(args[0]).includes('pg_advisory_unlock')) return query(...args)
            locked = connection
            probed = connection.query.mock.invocationCallOrder.slice(-1)[0]
            return Promise.reject(new Error('unlock probe'))
          })
          return connection
        })
        const destroy = jest.spyOn(knex.client, 'destroyRawConnection')
        const release = jest.spyOn(knex.client, 'releaseConnection')
        await resolve(sale.id, 'apply')
        expect(await ledger.retrieveTallyCommand(sale.id)).toMatchObject({ status: 'in_progress', needs_admin_reason: null })
        // Calls on that connection after the probe; the pool's validator may destroy it again once it is back.
        const order = (spy: jest.SpyInstance) => spy.mock.invocationCallOrder.filter((at, index) => at > probed && spy.mock.calls[index][0] === locked)
        expect([order(release).length, order(destroy)[0] < order(release)[0]]).toEqual([1, true])
        expect(locked!.__knex__disposed).toBeTruthy()
      })

      it('tally-ledger-resolve re-reads the row under the sale lock and refuses, touching no order, when it changed', async () => {
        const { sale, orderId } = await parkLiveOrder()
        const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
        const acquire = knex.client.acquireConnection.bind(knex.client)
        // The script's first read takes the first connection; the second is the one that takes the sale lock.
        jest.spyOn(knex.client, 'acquireConnection').mockImplementationOnce(acquire).mockImplementationOnce(async () => {
          await knex('tally_command').where({ id: sale.id }).update({ status: 'in_progress' })
          return acquire()
        })
        await expect(resolve(sale.id, 'reject')).rejects.toThrow(`Command ${sale.id} changed while resolving; nothing written`)
        expect(await ledger.retrieveTallyCommand(sale.id)).toMatchObject({ status: 'in_progress', result: null })
        expect(await liveOrders(sale.payload.clientOrderId)).toEqual([expect.objectContaining({ id: orderId })])
      })

      it('tally-ledger-resolve reject marks tally_rejected and takes back the top-up of an order an admin already cancelled by hand', async () => {
        const before = await levelC()
        const sale = saleOfC()
        const { orderId } = await parkLiveOrder(sale, 1)
        await cancelOrderWorkflow(container).run({ input: { order_id: orderId } })
        expect(await levelC()).toEqual([before[0] + 1, before[1]])
        await resolve(sale.id, 'reject')
        expect(await levelC()).toEqual(before)
        await expectRejectedAndReversed(sale, orderId)
      })

      it('tally-ledger-resolve refuses while the sale\'s lock is held and changes nothing', async () => {
        const { sale, orderId } = await parkLiveOrder()
        const row = await ledger.retrieveTallyCommand(sale.id)
        const busy = `tally_ledger_resolve: sale ${sale.payload.clientOrderId} is in progress; try again`
        const log = jest.spyOn(container.resolve(ContainerRegistrationKeys.LOGGER), 'error')
        const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
        const connection = await knex.client.acquireConnection()
        try {
          await connection.query("select pg_advisory_lock(hashtext('tally_order'), hashtext($1))", [sale.payload.clientOrderId])
          for (const action of ['apply', 'reject']) await expect(resolve(sale.id, action)).rejects.toThrow('is in progress; nothing written')
        } finally {
          await connection.query("select pg_advisory_unlock(hashtext('tally_order'), hashtext($1))", [sale.payload.clientOrderId])
          await knex.client.releaseConnection(connection)
        }
        expect(log.mock.calls).toEqual([[busy], [busy]])
        expect(await ledger.retrieveTallyCommand(sale.id)).toEqual(row)
        expect(await liveOrders(sale.payload.clientOrderId)).toEqual([expect.objectContaining({ id: orderId })])
      })

      it.each(['create', 'resume'])('the recipe\'s own fulfilment compensation on %s leaves no canceled fulfilment linked, so the resend is applied', async path => {
        const before = await levelA()
        const sale = command()
        if (path === 'resume') await halfWrittenOrder(sale)
        jest.spyOn(container.resolve(Modules.ORDER), 'registerFulfillment').mockRejectedValueOnce(new Error('fulfilment probe'))
        expect((await post([sale])).status).toBe(503)
        // The half-written order keeps its reservation of the one item until the resend fulfils it.
        expect(await levelA()).toEqual([before[0], before[1] + (path === 'resume' ? 1 : 0)])
        const ids = (await liveOrders(sale.payload.clientOrderId)).map(order => order.id)
        expect(ids).toHaveLength(path === 'resume' ? 1 : 0)
        const { data: orders } = ids.length ? await container.resolve(ContainerRegistrationKeys.QUERY).graph({
          entity: 'order', filters: { id: ids }, fields: ['fulfillments.id', 'fulfillments.canceled_at'] }) : { data: [] }
        expect(orders.flatMap(order => order.fulfillments).filter(fulfillment => fulfillment?.canceled_at)).toEqual([])
        const response = await post([sale])
        expect([response.status, response.data.results]).toEqual([200, [expect.objectContaining({ id: sale.id, status: 'applied' })]])
        expect(await levelA()).toEqual([before[0] - 1, before[1]])
      })

      it('tally-ledger-resolve reject cancels and marks the live order tally_rejected and stores a TALLY_ADMIN_REJECTED platform_error that the resend replays', async () => {
        const { sale, orderId } = await parkLiveOrder()
        await resolve(sale.id, 'reject', 'Refunded in the admin')
        expect(await liveOrders(sale.payload.clientOrderId)).toHaveLength(0)
        const [order] = await container.resolve(ContainerRegistrationKeys.PG_CONNECTION)('order').where({ id: orderId })
        expect(order.status).toBe('canceled')
        expect(order.metadata.tally_rejected).toBe(true)
        const rejection = { id: sale.id, status: 'rejected', error: { code: 'platform_error', message: 'Refunded in the admin', data: {
          platformCode: 'TALLY_ADMIN_REJECTED', platformMessage: 'Refunded in the admin', orderId,
        } } }
        expect(await ledger.retrieveTallyCommand(sale.id)).toMatchObject({ status: 'rejected', result: rejection })
        const response = await post([sale])
        expect([response.status, response.data.results]).toEqual([200, [rejection]])
        await expect(resolve(sale.id, 'apply')).rejects.toThrow('not needs_admin')
      })

      it('after a reject, a new command id for the same clientOrderId is applied as a new order', async () => {
        const { sale, orderId } = await parkLiveOrder()
        await resolve(sale.id, 'reject')
        const retry = { ...command(), payload: sale.payload }
        const response = await post([retry])
        expect([response.status, response.data.results]).toEqual([200, [expect.objectContaining({ id: retry.id, status: 'applied' })]])
        const live = await liveOrders(sale.payload.clientOrderId)
        expect(live).toEqual([expect.objectContaining({ id: response.data.results[0].serverRefs.orderId, status: 'completed' })])
        expect(live[0].id).not.toBe(orderId)
      })

      it('tally-ledger-resolve reject refuses when the order cannot be cancelled and leaves the row needs_admin without tally_rejected', async () => {
        const { sale, orderId } = await parkLiveOrder()
        // The package exports block deep imports; the module's own export is the one core-flows' getters read.
        const cancel = require(path.join(path.dirname(require.resolve('@medusajs/core-flows')), 'order/workflows/cancel-order'))
        jest.spyOn(cancel, 'cancelOrderWorkflow').mockReturnValue({ run: async () => { throw new Error('cancel probe') } })
        const log = jest.spyOn(container.resolve(ContainerRegistrationKeys.LOGGER), 'error')
        await expect(resolve(sale.id, 'reject')).rejects.toThrow('cancel probe')
        expect(log).toHaveBeenCalledWith(
          `tally_ledger_resolve: reject refused for command ${sale.id}: order ${orderId} could not be cancelled: cancel probe`)
        expect(await ledger.retrieveTallyCommand(sale.id)).toMatchObject({ status: 'needs_admin', result: null })
        expect(await liveOrders(sale.payload.clientOrderId)).toEqual([expect.objectContaining({ id: orderId })])
        const order = await container.resolve(Modules.ORDER).retrieveOrder(orderId)
        expect(order.metadata).not.toHaveProperty('tally_rejected')
      })

      it('tally-ledger-resolve apply makes the row reclaimable and the resend completes the order the admin fixed', async () => {
        const { sale, orderId, collectionId } = await parkLiveOrder()
        await container.resolve(ContainerRegistrationKeys.PG_CONNECTION)('payment_collection')
          .where({ id: collectionId }).update({ status: 'completed' })
        await resolve(sale.id, 'apply')
        expect(await ledger.retrieveTallyCommand(sale.id)).toMatchObject({ status: 'in_progress', needs_admin_reason: null })
        const response = await post([sale])
        expect([response.status, response.data.results]).toEqual([200, [expect.objectContaining({
          id: sale.id, status: 'applied', serverRefs: expect.objectContaining({ orderId }),
        })]])
        expect(await liveOrders(sale.payload.clientOrderId)).toEqual([expect.objectContaining({ id: orderId, status: 'completed' })])
      })
    })

    it('validates all envelopes before claiming any command', async () => {
      const sale = command()
      const response = await post([sale, { ...command(), deviceId: undefined }])
      expect(response.status).toBe(400)
      expect(response.data.message).toContain('commands[1].deviceId')
      expect(await ledger.listTallyCommands({ id: sale.id })).toHaveLength(0)
    })

    it('accepts 50 commands in a roughly 200 kB body', async () => {
      const sales = Array.from({ length: 50 }, () => {
        const sale = command()
        const { lines, ...payload } = sale.payload
        return { ...sale, payload: { ...payload, padding: 'x'.repeat(4000) } }
      })
      const bodySize = Buffer.byteLength(JSON.stringify({ commands: sales }))
      expect(bodySize).toBeGreaterThan(100 * 1024)
      expect(bodySize).toBeLessThan(250 * 1024)
      const response = await post(sales)
      expect(response.status).toBe(200)
      expect(response.data.results).toEqual(sales.map(sale => ({
        id: sale.id, status: 'rejected', error: {
          code: 'invalid_payload', message: expect.stringContaining('lines'),
        },
      })))
    })

    it('rejects a JSON body over 1 MB with 413', async () => {
      const sale = command()
      const oversized = { ...sale, payload: { ...sale.payload, padding: 'x'.repeat(1024 * 1024) } }
      expect((await post([oversized])).status).toBe(413)
      expect(await ledger.listTallyCommands({ id: sale.id })).toHaveLength(0)
    })

    it('rejects 51 commands with 413 without claiming any command', async () => {
      const sales = Array.from({ length: 51 }, () => command())
      expect((await post(sales)).status).toBe(413)
      expect(await ledger.listTallyCommands({ id: sales.map(sale => sale.id) })).toHaveLength(0)
    })

    it.each([false, true])('creates and replays a v3 sale with receipt figures, discounted=%s', async discounted => {
      const base = command()
      const taxMinor = discounted ? 144 : 160
      const totalMinor = discounted ? 900 : 1000
      const payload: OrderCreatePayloadV3 = { ...base.payload, subtotalMinor: totalMinor - taxMinor, taxMinor, totalMinor,
        ...(discounted ? { discountMinor: 100 } : {}),
        lines: [{ ...base.payload.lines[0], variantId: data.variantB, ...(discounted ? { discountMinor: 100 } : {}) }],
        payments: [{ ...base.payload.payments[0], amountMinor: totalMinor }],
        display: { currency: 'EUR', exponent: 2, taxInclusive: true, subtotalMinor: 1000,
          discountMinor: discounted ? 100 : 0, taxMinor, totalMinor, orderDiscountMinor: 0,
          lines: [{ clientLineId: base.payload.lines[0].clientLineId, amountMinor: totalMinor,
            discounts: discounted ? [{ discountId: 'd', label: 'Sale', amountMinor: 100 }] : [] }] },
        taxByRate: [{ ratePpm: 190000, code: 'VAT', netMinor: totalMinor - taxMinor, taxMinor, grossMinor: totalMinor }],
        ...(discounted ? { sessionId: randomUUID() } : {}),
      }
      const sale = { ...base, version: 3, payload }
      const first = await post([sale])
      expect(first.status).toBe(200)
      expect(first.data.results[0]).toMatchObject({ status: 'applied', serverRefs: { totalMinor } })
      const [order] = await liveOrders(payload.clientOrderId)
      expect(order.metadata.tally_pos_totals).toEqual({ v: 2, currency: 'EUR', exponent: 2,
        settlement: { subtotalMinor: totalMinor - taxMinor, discountMinor: discounted ? 100 : 0, taxMinor, totalMinor },
        display: payload.display, taxByRate: payload.taxByRate,
      })
      if (discounted) expect(order.metadata.tally_session_id).toBe(payload.sessionId)
      else expect(order.metadata).not.toHaveProperty('tally_session_id')
      expect((await post([sale])).data.results).toEqual([{ ...first.data.results[0], status: 'duplicate' }])
      const changed = { ...sale, payload: { ...payload, display: { ...payload.display!, subtotalMinor: 1001 } } }
      expect((await post([changed])).data.results[0]).toMatchObject({ status: 'rejected', error: { code: 'idempotency_mismatch' } })
      expect((await liveOrders(payload.clientOrderId))[0].metadata).toEqual(order.metadata)
      const invalid = { ...sale, id: randomUUID(), payload: { ...payload, display: { ...payload.display!, totalMinor: totalMinor + 1 } } }
      expect((await post([invalid])).data.results[0]).toMatchObject({ status: 'rejected', error: {
        code: 'invalid_payload', message: 'display.totalMinor: expected payload.totalMinor',
      } })
    })

    it.each(['email', 'id-only', 'unknown'])('creates v3 customerId orders: %s', async mode => {
      const email = `v3-${randomUUID()}@example.com`
      const customerId = mode === 'unknown' ? 'cus_unknown' : (await container.resolve(Modules.CUSTOMER).createCustomers({ email })).id
      const payload: OrderCreatePayloadV3 = { ...command().payload,
        customer: { customerId, ...(mode === 'email' ? { email } : {}) }, sessionId: 'unknown-session',
      }
      const sale = { ...command(), version: 3, payload }
      const response = await post([sale])
      expect(response.status).toBe(200)
      expect(response.data.results[0].status).toBe('applied')
      const [order] = await liveOrders(payload.clientOrderId)
      expect(order.customer_id).toBe(mode === 'unknown' ? null : customerId)
      expect(order.metadata.tally_customer_id).toBe(customerId)
      expect(order.metadata.tally_session_id).toBe('unknown-session')
      expect(order.metadata.tally_pos_totals.v).toBe(1)
      if (mode === 'email') expect(order.email).toBe(email)
    })

    it.each([
      [3, { sessionId: 'x'.repeat(37) }, 'sessionId: expected a string of at most 36 characters'],
      [3, { sessionId: '' }, 'sessionId: expected a string of at most 36 characters'],
      [2, { sessionId: 'session', discountMinor: 1 }, 'sessionId requires version 3'],
      [3, { customer: { customerId: 'x'.repeat(65) } }, 'customer.customerId: expected a string of at most 64 characters'],
      [2, { customer: { customerId: 'customer' }, discountMinor: 1 }, 'customerId requires version 3'],
    ])('rejects invalid v%s bookkeeping fields %j', async (version, fields, message) => {
      const sale = command()
      const response = await post([{ ...sale, version, payload: { ...sale.payload, ...fields } }])
      expect(response.status).toBe(200)
      expect(response.data.results[0]).toEqual({ id: sale.id, status: 'rejected', error: { code: 'invalid_payload', message } })
      expect(await liveOrders(sale.payload.clientOrderId)).toHaveLength(0)
    })
  },
})
