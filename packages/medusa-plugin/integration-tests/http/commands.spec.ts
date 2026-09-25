import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { MedusaContainer } from '@medusajs/framework/types'
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import type { CommandEnvelope, OrderCreatePayload } from '@tallyui/core'
import { TALLY_LEDGER_MODULE } from '../../src/modules/tally-ledger'
import type TallyLedgerModuleService from '../../src/modules/tally-ledger/service'
import { commandFingerprint } from '../../src/workflows/tally-order-create/fingerprint'
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
        expect([response.status, response.data]).toEqual([200, { contracts: { 'order.create': [1, 2] } }])
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
  },
})
