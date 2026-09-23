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
      const sales = [command(), command(), command()]
      const response = await post(sales)
      expect(response.status).toBe(503)
      expect(response.data).toEqual({ code: 'transient', id: sales[1].id, message: 'Temporary workflow failure' })
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

    it('rejects 51 commands with 413 without claiming any command', async () => {
      const sales = Array.from({ length: 51 }, () => command())
      expect((await post(sales)).status).toBe(413)
      expect(await ledger.listTallyCommands({ id: sales.map(sale => sale.id) })).toHaveLength(0)
    })
  },
})
