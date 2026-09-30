import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { MedusaContainer } from '@medusajs/framework/types'
import { WorkflowManager } from '@medusajs/framework/orchestration'
import { ContainerRegistrationKeys, Modules, ProductStatus } from '@medusajs/framework/utils'
import {
  cancelOrderWorkflow, convertDraftOrderWorkflow, createInventoryLevelsWorkflow, createOrderPaymentCollectionWorkflow, createOrderWorkflow, createProductsWorkflow,
  linkSalesChannelsToStockLocationWorkflow, markPaymentCollectionAsPaid,
  type CreateOrderWorkflowInput,
} from '@medusajs/medusa/core-flows'
import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import type { CommandEnvelope, OrderCreatePayload } from '@tallyui/core' with { 'resolution-mode': 'import' }
import { MAX_BODY_BYTES, MAX_COMMANDS } from '../../src/api/tally/v1/commands/process'
import { TALLY_LEDGER_MODULE } from '../../src/modules/tally-ledger'
import type TallyLedgerModuleService from '../../src/modules/tally-ledger/service'
import { TALLY_REGISTER_MODULE } from '../../src/modules/tally-register'
import type TallyRegisterModuleService from '../../src/modules/tally-register/service'
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

    it('GET /tally/v1/commands without auth gets 404 (no GET handler), not 401: the POST-only authenticate does not run for GET', async () => {
      const response = await api.get('/tally/v1/commands', { headers: { 'X-Tally-Protocol': '1' }, validateStatus: () => true })
      expect(response.status).toBe(404)
    })

    it('serves GET /tally/v1/info to bearer and session users, 401 otherwise, with CORS for adminCors origins (ADR-062)', async () => {
      const info = (requestHeaders: Record<string, string>) =>
        api.get('/tally/v1/info', { headers: requestHeaders, validateStatus: () => true })
      const session = await api.post('/auth/session', {}, { headers: { Authorization: headers.Authorization } })
      const cookie = session.headers['set-cookie']![0].split(';')[0]
      for (const requestHeaders of [{ Authorization: headers.Authorization }, { Cookie: cookie }] as Record<string, string>[]) {
        const response = await info(requestHeaders)
        expect([response.status, response.data]).toEqual([200, {
          contracts: { 'order.create': [1, 2, 3], register: [1], sync: [1] },
          taxRounding: { granularity: 'per_order', mode: 'half_away_from_zero' },
        }])
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
      expect(response.data).toEqual({
        contracts: { 'order.create': [1, 2, 3], register: [1], sync: [1] },
        taxRounding: { granularity: 'per_order', mode: 'half_away_from_zero' },
      })
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

    describe('unsellable variants and currency', () => {
      it('stores unknown_variant for a soft-deleted variant and replays it without creating an order', async () => {
        const sale = command()
        const products = container.resolve(Modules.PRODUCT)
        await products.softDeleteProductVariants([data.variantA])
        try {
          const response = await post([sale])
          expect(response.status).toBe(200)
          expect(response.data.results).toEqual([expect.objectContaining({
            id: sale.id, status: 'rejected', error: expect.objectContaining({ code: 'unknown_variant' }),
          })])
          expect(await ledger.retrieveTallyCommand(sale.id)).toMatchObject({
            status: 'rejected', result: response.data.results[0],
          })
          const replay = await post([sale])
          expect(replay.status).toBe(200)
          expect(replay.data.results).toEqual(response.data.results)
          expect(await container.resolve(ContainerRegistrationKeys.PG_CONNECTION)('order')
            .whereRaw("metadata->>'tally_client_id' = ?", [sale.payload.clientOrderId])).toHaveLength(0)
        } finally {
          await products.restoreProductVariants([data.variantA])
        }
      })

      it('stores unknown_variant for a soft-deleted product and replays it without creating an order', async () => {
        const sale = command()
        const products = container.resolve(Modules.PRODUCT)
        const variant = await products.retrieveProductVariant(data.variantA)
        await products.softDeleteProducts([variant.product_id!])
        try {
          const response = await post([sale])
          expect(response.status).toBe(200)
          expect(response.data.results).toEqual([expect.objectContaining({
            id: sale.id, status: 'rejected', error: expect.objectContaining({ code: 'unknown_variant' }),
          })])
          expect(await ledger.retrieveTallyCommand(sale.id)).toMatchObject({
            status: 'rejected', result: response.data.results[0],
          })
          const replay = await post([sale])
          expect(replay.status).toBe(200)
          expect(replay.data.results).toEqual(response.data.results)
          expect(await container.resolve(ContainerRegistrationKeys.PG_CONNECTION)('order')
            .whereRaw("metadata->>'tally_client_id' = ?", [sale.payload.clientOrderId])).toHaveLength(0)
        } finally {
          await products.restoreProducts([variant.product_id!])
        }
      })

      it('stores unknown_variant for a draft product and replays it without creating an order', async () => {
        const sale = command()
        const products = container.resolve(Modules.PRODUCT)
        const variant = await products.retrieveProductVariant(data.variantA, { relations: ['product'] })
        await products.updateProducts(variant.product_id!, { status: ProductStatus.DRAFT })
        try {
          const response = await post([sale])
          expect(response.status).toBe(200)
          expect(response.data.results).toEqual([expect.objectContaining({
            id: sale.id, status: 'rejected', error: expect.objectContaining({ code: 'unknown_variant' }),
          })])
          expect(await ledger.retrieveTallyCommand(sale.id)).toMatchObject({
            status: 'rejected', result: response.data.results[0],
          })
          const replay = await post([sale])
          expect(replay.status).toBe(200)
          expect(replay.data.results).toEqual(response.data.results)
          expect(await container.resolve(ContainerRegistrationKeys.PG_CONNECTION)('order')
            .whereRaw("metadata->>'tally_client_id' = ?", [sale.payload.clientOrderId])).toHaveLength(0)
        } finally {
          await products.updateProducts(variant.product_id!, { status: variant.product!.status })
        }
      })

      it('stores unknown_variant for a product removed from the sales channel and replays it without creating an order', async () => {
        const { data: [variant] } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({
          entity: 'product_variant', fields: ['product.shipping_profile.id'], filters: { id: data.variantA },
        })
        const { result: [product] } = await createProductsWorkflow(container).run({ input: { products: [{
          title: 'Removed from POS channel', handle: `off-channel-${randomUUID()}`, status: ProductStatus.PUBLISHED,
          shipping_profile_id: variant.product!.shipping_profile!.id, sales_channels: [{ id: data.channelId }],
          options: [{ title: 'Variant', values: ['A'] }],
          variants: [{ title: 'A', manage_inventory: false, options: { Variant: 'A' }, prices: [{ currency_code: 'eur', amount: 10 }] }],
        }] } })
        await container.resolve(ContainerRegistrationKeys.LINK).dismiss({
          [Modules.PRODUCT]: { product_id: product.id },
          [Modules.SALES_CHANNEL]: { sales_channel_id: data.channelId },
        })
        const sale = command()
        sale.payload.lines[0].variantId = product.variants[0].id
        const response = await post([sale])
        expect(response.status).toBe(200)
        expect(response.data.results).toEqual([expect.objectContaining({
          id: sale.id, status: 'rejected', error: expect.objectContaining({ code: 'unknown_variant' }),
        })])
        expect(await ledger.retrieveTallyCommand(sale.id)).toMatchObject({
          status: 'rejected', result: response.data.results[0],
        })
        const replay = await post([sale])
        expect(replay.status).toBe(200)
        expect(replay.data.results).toEqual(response.data.results)
        expect(await container.resolve(ContainerRegistrationKeys.PG_CONNECTION)('order')
          .whereRaw("metadata->>'tally_client_id' = ?", [sale.payload.clientOrderId])).toHaveLength(0)
      })

      it('rejects unsupported_currency without a ledger row on either send and creates no order', async () => {
        const sale = command({ currency: 'USD' })
        const response = await post([sale])
        expect(response.status).toBe(200)
        expect(response.data.results).toEqual([expect.objectContaining({
          id: sale.id, status: 'rejected', error: expect.objectContaining({ code: 'unsupported_currency' }),
        })])
        expect(await ledger.listTallyCommands({ id: sale.id }, { withDeleted: true })).toHaveLength(0)
        const replay = await post([sale])
        expect(replay.status).toBe(200)
        expect(replay.data.results).toEqual(response.data.results)
        expect(await ledger.listTallyCommands({ id: sale.id }, { withDeleted: true })).toHaveLength(0)
        expect(await container.resolve(ContainerRegistrationKeys.PG_CONNECTION)('order')
          .whereRaw("metadata->>'tally_client_id' = ?", [sale.payload.clientOrderId])).toHaveLength(0)
      })
    })

    describe('payload.locationId', () => {
      const linkSpare = (change: 'add' | 'remove') =>
        linkSalesChannelsToStockLocationWorkflow(container).run({ input: { id: data.spareId, [change]: [data.channelId] } })

      async function saleAt(orderId: string) {
        const { data: [order] } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({
          entity: 'order', fields: ['fulfillments.location_id'], filters: { id: orderId },
        })
        return order.fulfillments!.map(fulfillment => fulfillment!.location_id)
      }

      async function stockAndReservations() {
        const inventory = container.resolve(Modules.INVENTORY)
        const levels = await inventory.listInventoryLevels({ inventory_item_id: data.inventoryA })
        const reservations = await inventory.listReservationItems({ inventory_item_id: data.inventoryA })
        return { reservations: reservations.map(item => item.id).sort(),
          levels: levels.map(level => `${level.location_id} ${level.stocked_quantity} ${level.reserved_quantity}`).sort() }
      }

      async function expectRefused(sale: CommandEnvelope<OrderCreatePayload>, message: string) {
        const before = await stockAndReservations()
        const response = await post([sale])
        expect(response.status).toBe(200)
        expect(response.data.results).toEqual([expect.objectContaining({
          id: sale.id, status: 'rejected', error: expect.objectContaining({ code: 'store_configuration', message }),
        })])
        expect(await ledger.listTallyCommands({ id: sale.id }, { withDeleted: true })).toHaveLength(0)
        expect(await liveOrders(sale.payload.clientOrderId)).toHaveLength(0)
        expect(await stockAndReservations()).toEqual(before)
      }

      it('a location assigned to the channel is honoured: the fulfilment and the stock use it', async () => {
        await linkSpare('add')
        try {
          await createInventoryLevelsWorkflow(container).run({ input: { inventory_levels: [
            { inventory_item_id: data.inventoryA, location_id: data.spareId, stocked_quantity: 5 },
          ] } })
          const berlin = await levelA()
          const sale = command({ locationId: data.spareId })
          const response = await post([sale])
          expect(response.data.results).toEqual([expect.objectContaining({ id: sale.id, status: 'applied' })])
          expect(await saleAt(response.data.results[0].serverRefs.orderId)).toEqual([data.spareId])
          const [spare] = await container.resolve(Modules.INVENTORY).listInventoryLevels({ inventory_item_id: data.inventoryA, location_id: data.spareId })
          expect(Number(spare.stocked_quantity)).toBe(4)
          expect(await levelA()).toEqual(berlin)
        } finally {
          await linkSpare('remove')
        }
      })

      it('an unknown location is refused as unstored store_configuration with no order', async () => {
        await expectRefused(command({ locationId: 'sloc_unknown' }), 'payload.locationId: no stock location with this id')
      })

      it('a location outside the channel is refused unstored, again on a retry before the fix, and applies once it is linked', async () => {
        const sale = command({ locationId: data.spareId })
        for (const _attempt of [1, 2]) {
          await expectRefused(sale, "payload.locationId: this stock location is not assigned to the sale's sales channel")
        }
        await linkSpare('add')
        try {
          const retry = await post([sale])
          expect(retry.data.results).toEqual([expect.objectContaining({ id: sale.id, status: 'applied' })])
          expect(await liveOrders(sale.payload.clientOrderId)).toHaveLength(1)
          expect(await saleAt(retry.data.results[0].serverRefs.orderId)).toEqual([data.spareId])
        } finally {
          await linkSpare('remove')
        }
      })
    })

    describe('step order', () => {
      it('a v1 sale with lines[0].discountMinr is refused unstored as invalid_payload naming it, with no order (ruling 17)', async () => {
        const sale = command()
        Object.assign(sale.payload.lines[0], { discountMinr: 100 })
        const before = await levelA()
        const response = await post([sale])
        expect(response.status).toBe(200)
        expect(response.data.results).toEqual([{ id: sale.id, status: 'rejected', error: {
          code: 'invalid_payload', message: 'lines[0].discountMinr: unknown field for order.create version 1',
        } }])
        expect(await ledger.listTallyCommands({ id: sale.id }, { withDeleted: true })).toHaveLength(0)
        expect(await liveOrders(sale.payload.clientOrderId)).toHaveLength(0)
        expect(await levelA()).toEqual(before)
      })

      it('an envelope.priority between two good sales is refused alone, unstored, with no order (ruling 17)', async () => {
        const [before, refused, after] = [command(), { ...command(), priority: 1 }, command()]
        const response = await post([before, refused, after])
        expect(response.status).toBe(200)
        expect(response.data.results.map(result => result.status)).toEqual(['applied', 'rejected', 'applied'])
        expect(response.data.results[1]).toEqual({ id: refused.id, status: 'rejected', error: {
          code: 'invalid_payload', message: 'envelope.priority: unknown field for order.create version 1',
        } })
        expect(await ledger.listTallyCommands({ id: refused.id }, { withDeleted: true })).toHaveLength(0)
        expect(await liveOrders(refused.payload.clientOrderId)).toHaveLength(0)
      })

      it('an applied id resent with envelope.priority answers duplicate, because the replay read comes first', async () => {
        const sale = command()
        const first = await post([sale])
        expect(first.data.results[0].status).toBe('applied')
        const response = await post([{ ...sale, attempt: 2, priority: 1 }])
        expect(response.status).toBe(200)
        expect(response.data.results).toEqual([{ ...first.data.results[0], status: 'duplicate' }])
      })

      it('an envelope.createdAt before 2020 between two good sales is refused alone, unstored, with no order (TallyUI #325)', async () => {
        const [before, refused, after] = [command(), { ...command(), createdAt: '2019-12-31T23:59:59.999Z' }, command()]
        const response = await post([before, refused, after])
        expect(response.status).toBe(200)
        expect(response.data.results.map(result => result.status)).toEqual(['applied', 'rejected', 'applied'])
        expect(response.data.results[1]).toEqual({ id: refused.id, status: 'rejected', error: { code: 'invalid_payload',
          message: "envelope.createdAt: expected a time from 2020-01-01T00:00:00Z to 24 hours after the server's clock" } })
        expect(await ledger.listTallyCommands({ id: refused.id }, { withDeleted: true })).toHaveLength(0)
        expect(await liveOrders(refused.payload.clientOrderId)).toHaveLength(0)
      })

      it('an applied id resent with an envelope.createdAt before 2020 answers duplicate, because the replay read comes first', async () => {
        const sale = command()
        const first = await post([sale])
        expect(first.data.results[0].status).toBe('applied')
        const response = await post([{ ...sale, attempt: 2, createdAt: '2019-12-31T23:59:59.999Z' }])
        expect(response.status).toBe(200)
        expect(response.data.results).toEqual([{ ...first.data.results[0], status: 'duplicate' }])
      })

      it('an applied id resent with an extra unknown field answers duplicate, because the replay read comes first', async () => {
        const first = await post([command()])
        expect(first.data.results[0].status).toBe('applied')
        // Recorded as applied, as a command carrying an unknown field could be before ruling 17.
        const extra = command()
        Object.assign(extra.payload, { note: 'gift wrap' })
        const claim = await ledger.claim({ id: extra.id, type: extra.type, fingerprint: commandFingerprint(extra) })
        if (!claim.claimed) throw new Error('Expected a fresh claim')
        const result = { ...first.data.results[0], id: extra.id }
        await ledger.complete(extra.id, claim.claimToken, result)
        const response = await post([extra])
        expect(response.status).toBe(200)
        expect(response.data.results).toEqual([{ ...result, status: 'duplicate' }])
      })

      it('a v1 sale repeating a clientLineId is refused unstored as invalid_payload with no order, and the next command applies', async () => {
        const [refused, next] = [command(), command()]
        refused.payload.lines.push({ ...refused.payload.lines[0] })
        const response = await post([refused, next])
        expect(response.status).toBe(200)
        expect(response.data.results.map(result => result.status)).toEqual(['rejected', 'applied'])
        expect(response.data.results[0]).toEqual({ id: refused.id, status: 'rejected', error: {
          code: 'invalid_payload', message: 'lines[1].clientLineId: expected no duplicate of lines[0].clientLineId',
        } })
        expect(await ledger.listTallyCommands({ id: refused.id }, { withDeleted: true })).toHaveLength(0)
        expect(await liveOrders(refused.payload.clientOrderId)).toHaveLength(0)
      })

      it('an applied id resent with a repeated clientLineId answers duplicate, because the replay read comes first', async () => {
        const first = await post([command()])
        expect(first.data.results[0].status).toBe('applied')
        const repeated = command()
        repeated.payload.lines.push({ ...repeated.payload.lines[0] })
        const claim = await ledger.claim({ id: repeated.id, type: repeated.type, fingerprint: commandFingerprint(repeated) })
        if (!claim.claimed) throw new Error('Expected a fresh claim')
        const result = { ...first.data.results[0], id: repeated.id }
        await ledger.complete(repeated.id, claim.claimToken, result)
        const response = await post([repeated])
        expect(response.status).toBe(200)
        expect(response.data.results).toEqual([{ ...result, status: 'duplicate' }])
      })

      it('an applied id resent with an over-long title answers duplicate', async () => {
        const first = await post([command()])
        expect(first.status).toBe(200)
        expect(first.data.results[0].status).toBe('applied')
        const overLong = command()
        overLong.payload.lines[0].title = 'x'.repeat(256)
        const claim = await ledger.claim({ id: overLong.id, type: overLong.type, fingerprint: commandFingerprint(overLong) })
        if (!claim.claimed) throw new Error('Expected a fresh claim')
        const result = { ...first.data.results[0], id: overLong.id }
        await ledger.complete(overLong.id, claim.claimToken, result)
        const response = await post([overLong])
        expect(response.status).toBe(200)
        expect(response.data.results).toEqual([{ ...result, status: 'duplicate' }])
      })

      it('an applied id recorded at version 4 answers duplicate', async () => {
        const first = await post([command()])
        expect(first.status).toBe(200)
        expect(first.data.results[0].status).toBe('applied')
        const version4 = { ...command(), version: 4 }
        const claim = await ledger.claim({ id: version4.id, type: version4.type, fingerprint: commandFingerprint(version4 as unknown as Parameters<typeof commandFingerprint>[0]) })
        if (!claim.claimed) throw new Error('Expected a fresh claim')
        const result = { ...first.data.results[0], id: version4.id }
        await ledger.complete(version4.id, claim.claimToken, result)
        const response = await post([version4])
        expect(response.status).toBe(200)
        expect(response.data.results).toEqual([{ ...result, status: 'duplicate' }])
      })

      it('a fresh command with a 256-character title answers unstored invalid_payload', async () => {
        const sale = command()
        sale.payload.lines[0].title = 'x'.repeat(256)
        const response = await post([sale])
        expect(response.status).toBe(200)
        expect(response.data.results).toEqual([{ id: sale.id, status: 'rejected', error: {
          code: 'invalid_payload', message: 'lines[0].title: expected at most 255 characters',
        } }])
        expect(await ledger.listTallyCommands({ id: sale.id })).toHaveLength(0)
      })

      it('a fresh command with NUL in clientOrderId answers unstored invalid_payload', async () => {
        const sale = command({ clientOrderId: 'order\0id' })
        const response = await post([sale])
        expect(response.status).toBe(200)
        expect(response.data.results).toEqual([{ id: sale.id, status: 'rejected', error: {
          code: 'invalid_payload', message: 'clientOrderId: expected no NUL character',
        } }])
        expect(await ledger.listTallyCommands({ id: sale.id })).toHaveLength(0)
      })

      it('a rejected id resent with an over-long title answers its recorded rejection', async () => {
        const sale = command()
        sale.payload.lines[0].title = 'x'.repeat(256)
        const claim = await ledger.claim({ id: sale.id, type: sale.type, fingerprint: commandFingerprint(sale) })
        if (!claim.claimed) throw new Error('Expected a fresh claim')
        const result = { id: sale.id, status: 'rejected' as const, error: { code: 'underpaid', message: 'Payments do not cover the total.' } }
        await ledger.complete(sale.id, claim.claimToken, result)
        const response = await post([sale])
        expect(response.status).toBe(200)
        expect(response.data.results).toEqual([result])
      })
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
      const fulfil = jest.spyOn(container.resolve(Modules.FULFILLMENT), 'createFulfillment')
        .mockRejectedValueOnce(Object.assign(new Error('Fulfillment probe failed'), { name: 'FulfillmentProbeError' }))
      try {
        await expect(run.runOrderCreate(container, sale, {}, {
          claimToken: claim.claimToken, carriedTopUps: [],
        })).rejects.toMatchObject({
          name: 'FulfillmentProbeError', message: 'Fulfillment probe failed',
        })
      } finally {
        fulfil.mockRestore()
      }
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
      // The spy patches the built plugin the server loads, so this needs a fresh .medusa build (pretest runs it).
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

    describe('clientOrderId collision', () => {
      it('a sale lock held on another connection gives B 409 in_progress without a row', async () => {
        const a = command()
        expect((await post([a])).status).toBe(200)
        const b = { ...a, id: randomUUID() }
        const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
        const connection = await knex.client.acquireConnection()
        try {
          await connection.query("select pg_advisory_lock(hashtext('tally_order'), hashtext($1))", [a.payload.clientOrderId])
          const response = await post([b])
          expect([response.status, response.data]).toEqual([409, { code: 'in_progress', id: b.id }])
          expect(await ledger.listTallyCommands({ id: b.id })).toHaveLength(0)
        } finally {
          await connection.query("select pg_advisory_unlock(hashtext('tally_order'), hashtext($1))", [a.payload.clientOrderId])
          await knex.client.releaseConnection(connection)
        }
      })

      it('a fresh in_progress A gives B 503 without a row and leaves the order unchanged', async () => {
        const a = command()
        expect((await post([a])).status).toBe(200)
        const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
        await knex('tally_command').where({ id: a.id }).update({ status: 'in_progress', result: null, updated_at: knex.fn.now() })
        const before = await liveOrders(a.payload.clientOrderId)
        const b = { ...a, id: randomUUID() }
        const response = await post([b])
        expect(response.status).toBe(503)
        expect(response.data).toMatchObject({ code: 'transient', id: b.id })
        expect(await ledger.listTallyCommands({ id: b.id })).toHaveLength(0)
        expect(await liveOrders(a.payload.clientOrderId)).toEqual(before)
      })

      it('a stale in_progress A is superseded by applied B and replays B as duplicate with id A', async () => {
        const a = command()
        const first = await post([a])
        expect(first.status).toBe(200)
        const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
        await knex('tally_command').where({ id: a.id }).update({
          status: 'in_progress', result: null, updated_at: knex.raw("now() - interval '1 hour'"),
        })
        const b = { ...a, id: randomUUID() }
        const response = await post([b])
        expect([response.status, response.data.results]).toEqual([200, [expect.objectContaining({
          id: b.id, status: 'applied', serverRefs: first.data.results[0].serverRefs,
        })]])
        expect(await ledger.retrieveTallyCommand(b.id)).toMatchObject({ status: 'applied', result: response.data.results[0] })
        expect(await ledger.retrieveTallyCommand(a.id)).toMatchObject({ status: 'superseded', superseded_by: b.id })
        const replay = await post([a])
        expect([replay.status, replay.data.results]).toEqual([200, [{ ...response.data.results[0], id: a.id, status: 'duplicate' }]])
        expect(await liveOrders(a.payload.clientOrderId)).toHaveLength(1)
      })

      it('two concurrent Bs on stale A apply exactly one, return 409 without a row for the loser, and supersede A', async () => {
        const a = command()
        expect((await post([a])).status).toBe(200)
        const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
        await knex('tally_command').where({ id: a.id }).update({
          status: 'in_progress', result: null, updated_at: knex.raw("now() - interval '1 hour'"),
        })
        const bs = [{ ...a, id: randomUUID() }, { ...a, id: randomUUID() }]
        const responses = await Promise.all(bs.map(b => post([b])))
        expect(responses.map(response => response.status).sort()).toEqual([200, 409])
        const winner = responses.find(response => response.status === 200)!.data.results[0]
        const loser = bs.find(b => b.id !== winner.id)!
        expect(winner.status).toBe('applied')
        expect(responses.find(response => response.status === 409)!.data).toEqual({ code: 'in_progress', id: loser.id })
        expect(await ledger.listTallyCommands({ id: loser.id })).toHaveLength(0)
        expect(await ledger.retrieveTallyCommand(winner.id)).toMatchObject({ status: 'applied' })
        expect(await ledger.retrieveTallyCommand(a.id)).toMatchObject({ status: 'superseded', superseded_by: winner.id })
        expect(await liveOrders(a.payload.clientOrderId)).toHaveLength(1)
      })

      it('an applied A copies its stored warnings and serverRefs to B despite a different totalMinor, then B replays as duplicate', async () => {
        const a = command({ totalMinor: 999 })
        const first = await post([a])
        expect(first.status).toBe(200)
        expect(first.data.results[0].warnings).toContainEqual({ code: 'total_mismatch', expectedMinor: 999, serverMinor: 1000 })
        const b = { ...a, id: randomUUID(), payload: { ...a.payload, totalMinor: 1000 } }
        const response = await post([b])
        const copied = { ...first.data.results[0], id: b.id, status: 'applied' }
        expect([response.status, response.data.results]).toEqual([200, [copied]])
        expect(await ledger.retrieveTallyCommand(b.id)).toMatchObject({ status: 'applied', result: copied })
        const replay = await post([b])
        expect([replay.status, replay.data.results]).toEqual([200, [{ ...copied, status: 'duplicate' }]])
        expect(await liveOrders(a.payload.clientOrderId)).toHaveLength(1)
      })

      it('a needs_admin A gives B 503 without a row and leaves A unchanged', async () => {
        const a = command()
        expect((await post([a])).status).toBe(200)
        const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
        await knex('tally_command').where({ id: a.id }).update({ status: 'needs_admin', result: null })
        const before = await knex('tally_command').where({ id: a.id }).first()
        const b = { ...a, id: randomUUID() }
        const response = await post([b])
        expect(response.status).toBe(503)
        expect(response.data).toMatchObject({ code: 'transient', id: b.id })
        expect(await ledger.listTallyCommands({ id: b.id })).toHaveLength(0)
        expect(await knex('tally_command').where({ id: a.id }).first()).toEqual(before)
      })

      it('a deleted A row lets B resume the orphan order with the same order id', async () => {
        const a = command()
        const first = await post([a])
        expect(first.status).toBe(200)
        await container.resolve(ContainerRegistrationKeys.PG_CONNECTION)('tally_command').where({ id: a.id }).delete()
        const b = { ...a, id: randomUUID() }
        const response = await post([b])
        expect([response.status, response.data.results]).toEqual([200, [expect.objectContaining({
          id: b.id, status: 'applied', serverRefs: first.data.results[0].serverRefs,
        })]])
        expect(await ledger.retrieveTallyCommand(b.id)).toMatchObject({ status: 'applied' })
        expect(await liveOrders(a.payload.clientOrderId)).toHaveLength(1)
      })

      it('a rejected A with a live order gives B 503 and logs the rejected-command error once', async () => {
        const a = command()
        const first = await post([a])
        expect(first.status).toBe(200)
        await container.resolve(ContainerRegistrationKeys.PG_CONNECTION)('tally_command').where({ id: a.id }).update({
          status: 'rejected', result: JSON.stringify({ id: a.id, status: 'rejected', error: { code: 'platform_error', message: 'probe' } }),
        })
        const log = jest.spyOn(container.resolve(ContainerRegistrationKeys.LOGGER), 'error')
        const b = { ...a, id: randomUUID() }
        const response = await post([b])
        expect(response.status).toBe(503)
        expect(response.data).toMatchObject({ code: 'transient', id: b.id })
        expect(await ledger.listTallyCommands({ id: b.id })).toHaveLength(0)
        expect(log.mock.calls.filter(([line]) => String(line).startsWith('tally order.create: rejected command'))).toEqual([
          [`tally order.create: rejected command ${a.id} still has live order ${first.data.results[0].serverRefs.orderId}`],
        ])
      })

      it('an A superseded by applied C lets a new D copy C serverRefs and stored warnings', async () => {
        const a = command()
        expect((await post([a])).status).toBe(200)
        const c = command({ totalMinor: 998 })
        const successor = await post([c])
        expect(successor.status).toBe(200)
        await container.resolve(ContainerRegistrationKeys.PG_CONNECTION)('tally_command').where({ id: a.id }).update({
          status: 'superseded', result: null, superseded_by: c.id,
        })
        const d = { ...a, id: randomUUID() }
        const response = await post([d])
        const copied = { ...successor.data.results[0], id: d.id, status: 'applied' }
        expect([response.status, response.data.results]).toEqual([200, [copied]])
        expect(await ledger.retrieveTallyCommand(d.id)).toMatchObject({ status: 'applied', result: copied })
      })
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

      // A reject made before tally-ledger-resolve marked its order: rejected normally, then the marker removed.
      async function rejectUnmarked(sale = command()) {
        const { orderId } = await parkLiveOrder(sale)
        await resolve(sale.id, 'reject')
        // The order module merges metadata; an empty string deletes the key.
        await container.resolve(Modules.ORDER).updateOrders(orderId, { metadata: { tally_rejected: '' } })
        const row = await orderRow(orderId)
        expect([row.status, row.metadata]).toEqual(['canceled', expect.not.objectContaining({ tally_rejected: expect.anything() })])
        return { sale, orderId }
      }
      function orderRow(id: string) {
        return container.resolve(ContainerRegistrationKeys.PG_CONNECTION)('order').where({ id }).first()
      }
      async function backfill(...args: string[]) {
        const script = require(`${built}/scripts/tally-ledger-backfill-rejected`) as typeof import('../../src/scripts/tally-ledger-backfill-rejected')
        const info = jest.spyOn(container.resolve(ContainerRegistrationKeys.LOGGER), 'info')
        await script.default({ container, args })
        const lines = info.mock.calls.map(([line]) => String(line)).filter(line => line.startsWith('tally_ledger_backfill_rejected'))
        info.mockRestore()
        return lines
      }
      // A register session with a float of 100, and a version 3 sale in it.
      async function openSession() {
        const sessionId = randomUUID()
        await container.resolve<TallyRegisterModuleService>(TALLY_REGISTER_MODULE).openSession({
          sessionId, registerId: randomUUID(), openedAt: new Date().toISOString(), countedFloatMinor: 100 })
        return sessionId
      }
      function sessionSale(sessionId: string) {
        const base = command()
        // @tallyui/core's envelope type stops at version 2.
        return { ...base, version: 3, payload: { ...base.payload, sessionId } } as unknown as CommandEnvelope<OrderCreatePayload>
      }
      // Closes an openSession session through the endpoint with a closure that lists these orders' clientOrderIds.
      async function closeSession(sessionId: string, ...sales: CommandEnvelope<OrderCreatePayload>[]) {
        const session = await container.resolve(ContainerRegistrationKeys.PG_CONNECTION)('tally_register_session').where({ id: sessionId }).first()
        const at = new Date().toISOString()
        const envelope = (type: string, payload: object) => ({ ...command(), type, payload })
        const response = await post([envelope('register.session.transition', { sessionId, status: 'closed', at, counted: { cash: 100 } }),
          envelope('register.closure.submit', { closureId: randomUUID(), sessionId, registerId: session.register_id, number: 1,
            openedAt: session.opened_at, closedAt: at, tillExpected: { cash: 100 }, counted: { cash: 100 }, periodSalesTotalMinor: 0,
            periodRefundsTotalMinor: 0, perpetualSalesTotalMinor: 0, perpetualRefundsTotalMinor: 0, unsyncedCount: 0, unsyncedTotalMinor: 0,
            softwareVersion: '1.0', orderIds: sales.map(sale => sale.payload.clientOrderId), movementIds: [] })])
        expect([response.status, ...response.data.results.map(result => result.status)]).toEqual([200, 'applied', 'applied'])
      }
      const summary = (counts: string, skipped = '0 (already marked 0, not canceled 0, missing 0, no orderId 0)') =>
        `tally_ledger_backfill_rejected${counts} order(s), skipped ${skipped}`

      it('tally-ledger-backfill-rejected marks an unmarked rejected order, and a second run marks none', async () => {
        const { sale, orderId } = await rejectUnmarked()
        expect(await backfill('apply')).toEqual([
          `tally_ledger_backfill_rejected: command ${sale.id}, order ${orderId}, session none: cash 1000`,
          `tally_ledger_backfill_rejected: no session: orders ${orderId}`, summary(': marked 1')])
        expect((await orderRow(orderId)).metadata).toMatchObject({
          tally_rejected: true, tally_rejected_by: 'backfill', tally_client_id: expect.any(String) })
        expect(await backfill('apply')).toEqual([summary(': marked 0', '1 (already marked 1, not canceled 0, missing 0, no orderId 0)')])
      })

      it('tally-ledger-backfill-rejected without apply writes nothing and reports what it would mark', async () => {
        const sessionId = await openSession()
        const { sale, orderId } = await rejectUnmarked(sessionSale(sessionId))
        const row = await orderRow(orderId)
        expect(await backfill()).toEqual([
          `tally_ledger_backfill_rejected: command ${sale.id}, order ${orderId}, session ${sessionId}: cash 1000`,
          `tally_ledger_backfill_rejected: session ${sessionId} (open): expected cash 1100 -> 100; salesCount 1 -> 0; orders ${orderId}`,
          summary(' (dry run): would mark 1')])
        expect(await orderRow(orderId)).toEqual(row)
        await expect(backfill('--aply')).rejects.toThrow('[apply | undo] (no argument: a dry run)')
      })

      // The mode is a plain word: medusa exec refuses or drops a dashed option, so --apply is never taken for apply.
      it('tally-ledger-backfill-rejected --apply throws the usage error and writes nothing', async () => {
        const { orderId } = await rejectUnmarked()
        const row = await orderRow(orderId)
        await expect(backfill('--apply')).rejects.toThrow(
          'Usage: medusa exec tally-ledger-backfill-rejected.js [apply | undo] (no argument: a dry run)')
        expect(await orderRow(orderId)).toEqual(row)
      })

      it('tally-ledger-backfill-rejected: the dry run reports the session figures apply then shows', async () => {
        const sessionId = await openSession()
        const { orderId } = await rejectUnmarked(sessionSale(sessionId))
        const sessionLines = (lines: string[]) => lines.filter(line => line.includes(`session ${sessionId} (`))
        const dry = sessionLines(await backfill())
        expect(dry).toEqual([
          `tally_ledger_backfill_rejected: session ${sessionId} (open): expected cash 1100 -> 100; salesCount 1 -> 0; orders ${orderId}`])
        expect(sessionLines(await backfill('apply'))).toEqual(dry)
      })

      it('tally-ledger-backfill-rejected: a closed session whose closure lists the order reports what apply shows', async () => {
        const sessionId = await openSession()
        const { sale, orderId } = await rejectUnmarked(sessionSale(sessionId))
        await closeSession(sessionId, sale)
        const line = `tally_ledger_backfill_rejected: session ${sessionId} (closed): expected cash 1100 -> 100; salesCount 1 -> 0; ` +
          `variance cash -1000 -> 0; orders ${orderId}`
        expect((await backfill()).slice(1, -1)).toEqual([line])
        expect((await backfill('apply')).slice(1, -1)).toEqual([line])
      })

      it('tally-ledger-backfill-rejected: a closed session whose closure does not list the order is unchanged', async () => {
        const sessionId = await openSession()
        const { orderId } = await rejectUnmarked(sessionSale(sessionId))
        await closeSession(sessionId)
        const lines = [`tally_ledger_backfill_rejected: no session: orders ${orderId}`]
        expect((await backfill()).slice(1, -1)).toEqual(lines)
        expect((await backfill('apply')).slice(1, -1)).toEqual(lines)
      })

      it('tally-ledger-backfill-rejected: an order sent without sessionId that a closure lists changes that closed session', async () => {
        const sessionId = await openSession()
        const { sale, orderId } = await rejectUnmarked()
        await closeSession(sessionId, sale)
        const line = `tally_ledger_backfill_rejected: session ${sessionId} (closed): expected cash 1100 -> 100; salesCount 1 -> 0; ` +
          `variance cash -1000 -> 0; orders ${orderId}`
        expect(await backfill()).toEqual([`tally_ledger_backfill_rejected: command ${sale.id}, order ${orderId}, session none: cash 1000`,
          line, summary(' (dry run): would mark 1')])
        expect((await backfill('apply')).slice(1, -1)).toEqual([line])
      })

      it('tally-ledger-backfill-rejected undo unmarks only what apply marked, and the session figures go back', async () => {
        const sessionId = await openSession()
        const { sale, orderId } = await rejectUnmarked(sessionSale(sessionId))
        // Rejected after tally-ledger-resolve marked orders itself: no tally_rejected_by.
        const { sale: other, orderId: resolved } = await parkLiveOrder(sessionSale(sessionId))
        await resolve(other.id, 'reject')
        expect((await backfill('apply')).pop()).toBe(summary(': marked 1', '1 (already marked 1, not canceled 0, missing 0, no orderId 0)'))
        const resolvedRow = await orderRow(resolved)
        expect(resolvedRow.metadata).toMatchObject({ tally_rejected: true })
        expect(await backfill('undo')).toEqual([
          `tally_ledger_backfill_rejected: command ${sale.id}, order ${orderId}, session ${sessionId}: cash 1000`,
          `tally_ledger_backfill_rejected: session ${sessionId} (open): expected cash 100 -> 1100; salesCount 0 -> 1; orders ${orderId}`,
          'tally_ledger_backfill_rejected (undo): unmarked 1 order(s)'])
        expect((await orderRow(orderId)).metadata).not.toHaveProperty('tally_rejected')
        expect((await orderRow(orderId)).metadata).not.toHaveProperty('tally_rejected_by')
        expect(await orderRow(resolved)).toEqual(resolvedRow)
      })

      it('tally-ledger-resolve reject clears a tally_rejected_by it finds, so undo leaves the order marked', async () => {
        const { sale, orderId } = await parkLiveOrder()
        await container.resolve(Modules.ORDER).updateOrders(orderId, { metadata: { tally_rejected_by: 'backfill' } })
        expect((await orderRow(orderId)).metadata).toMatchObject({ tally_rejected_by: 'backfill' })
        await resolve(sale.id, 'reject')
        expect((await orderRow(orderId)).metadata).toMatchObject({ tally_rejected: true })
        expect((await orderRow(orderId)).metadata).not.toHaveProperty('tally_rejected_by')
        await backfill('undo')
        expect((await orderRow(orderId)).metadata).toMatchObject({ tally_rejected: true })
      })

      it('tally-ledger-backfill-rejected skips a rejection that names no order and one whose order is missing', async () => {
        const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
        const { sale: unnamed } = await rejectUnmarked()
        await knex('tally_command').where({ id: unnamed.id }).update({ result: knex.raw("result #- '{error,data,orderId}'") })
        const { orderId: gone } = await rejectUnmarked()
        await knex('order').where({ id: gone }).update({ deleted_at: new Date() })
        const warn = jest.spyOn(container.resolve(ContainerRegistrationKeys.LOGGER), 'warn')
        expect(await backfill()).toEqual([
          summary(' (dry run): would mark 0', '2 (already marked 0, not canceled 0, missing 1, no orderId 1)')])
        expect(warn).toHaveBeenCalledWith(`tally_ledger_backfill_rejected: skipped: no orderId (command ${unnamed.id})`)
      })

      it('tally-ledger-backfill-rejected never runs by itself: nothing in src outside scripts names it', () => {
        const src = path.resolve(__dirname, '../../src')
        const files = fs.readdirSync(src, { recursive: true, encoding: 'utf8' })
          .filter(file => !file.startsWith(`scripts${path.sep}`) && fs.statSync(path.join(src, file)).isFile())
        expect(files.length).toBeGreaterThan(20)
        expect(files.filter(file => /tally-ledger-backfill-rejected|tallyLedgerBackfillRejected/
          .test(fs.readFileSync(path.join(src, file), 'utf8')))).toEqual([])
      })

      it('tally-ledger-backfill-rejected leaves an earlier canceled order of the same sale unmarked', async () => {
        const first = command()
        const applied = await post([first])
        expect(applied.data.results[0].status).toBe('applied')
        const earlier = applied.data.results[0].serverRefs.orderId
        await container.resolve(ContainerRegistrationKeys.PG_CONNECTION)('order').where({ id: earlier }).update({ status: 'canceled' })
        const { orderId } = await rejectUnmarked({ ...first, id: randomUUID() })
        expect((await backfill('apply')).pop()).toBe(summary(': marked 1'))
        expect((await orderRow(orderId)).metadata.tally_rejected).toBe(true)
        expect(await orderRow(earlier)).toMatchObject({ status: 'canceled', metadata: expect.not.objectContaining({ tally_rejected: true }) })
      })

      it('tally-ledger-backfill-rejected skips and warns about a rejected command whose order is not canceled', async () => {
        const { sale, orderId } = await rejectUnmarked()
        await container.resolve(ContainerRegistrationKeys.PG_CONNECTION)('order').where({ id: orderId }).update({ status: 'completed' })
        const warn = jest.spyOn(container.resolve(ContainerRegistrationKeys.LOGGER), 'warn')
        expect(await backfill('apply')).toEqual([summary(': marked 0', '1 (already marked 0, not canceled 1, missing 0, no orderId 0)')])
        expect(warn).toHaveBeenCalledWith(
          `tally_ledger_backfill_rejected: command ${sale.id} is rejected but its order ${orderId} is completed; left unmarked`)
        expect((await orderRow(orderId)).metadata).not.toHaveProperty('tally_rejected')
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

    // The exact request body for `commands`, padded with insignificant whitespace after the opening
    // brace to exactly `bytes` bytes. Strict fields refuse an extra field, and string fields are capped.
    function paddedBody(commands: unknown[], bytes: number) {
      const json = JSON.stringify({ commands })
      const body = `{${' '.repeat(bytes - Buffer.byteLength(json))}${json.slice(1)}`
      expect(Buffer.byteLength(body)).toBe(bytes)
      return body
    }

    // A body holding one sale, exactly `bytes` long.
    function paddedSale(bytes: number) {
      const sale = command()
      return { sale, body: paddedBody([sale], bytes) }
    }

    // Sends `body` unchanged (no axios JSON transform).
    function postRaw(body: string) {
      return api.post('/tally/v1/commands', body, { headers: { ...headers, 'Content-Type': 'application/json' },
        transformRequest: [(data: string) => data], validateStatus: () => true })
    }

    it('rejects a JSON body over MAX_BODY_BYTES with 413', async () => {
      const sale = command()
      const oversized = { ...sale, payload: { ...sale.payload, padding: 'x'.repeat(MAX_BODY_BYTES) } }
      const response = await post([oversized])
      expect(response.status).toBe(413)
      expect(response.data).toEqual({ code: 'body_too_large', maxBytes: MAX_BODY_BYTES,
        message: `Request body over ${MAX_BODY_BYTES} bytes` })
      expect(await ledger.listTallyCommands({ id: sale.id })).toHaveLength(0)
    })

    it('accepts and applies a body of exactly MAX_BODY_BYTES', async () => {
      const response = await postRaw(paddedSale(MAX_BODY_BYTES).body)
      expect(response.status).toBe(200)
      expect(response.data.results[0].status).toBe('applied')
    })

    it('refuses a body of MAX_BODY_BYTES + 1 as body_too_large', async () => {
      const { sale, body } = paddedSale(MAX_BODY_BYTES + 1)
      const response = await postRaw(body)
      expect(response.status).toBe(413)
      expect(response.data).toEqual({ code: 'body_too_large', maxBytes: MAX_BODY_BYTES,
        message: `Request body over ${MAX_BODY_BYTES} bytes` })
      expect(await ledger.listTallyCommands({ id: sale.id })).toHaveLength(0)
    })

    it('a body over both limits answers body_too_large, not batch_too_large', async () => {
      const sales = Array.from({ length: MAX_COMMANDS + 1 }, () => command())
      const response = await postRaw(paddedBody(sales, MAX_BODY_BYTES + 1))
      expect(response.status).toBe(413)
      expect(response.data.code).toBe('body_too_large')
    })

    it('answers malformed JSON with Medusa\'s 400, not a 413', async () => {
      const sale = command()
      const malformed = JSON.stringify({ commands: [sale] }).slice(0, -2)
      const response = await api.post('/tally/v1/commands', malformed, { headers: { ...headers, 'Content-Type': 'application/json' },
        transformRequest: [(body: string) => body], validateStatus: () => true })
      expect(response.status).toBe(400)
      expect(response.data).toEqual({ type: 'invalid_data', message: expect.any(String) })
      expect(await ledger.listTallyCommands({ id: sale.id })).toHaveLength(0)
    })

    it('rejects 51 commands with 413 without claiming any command', async () => {
      const sales = Array.from({ length: 51 }, () => command())
      const response = await post(sales)
      expect(response.status).toBe(413)
      expect(response.data).toEqual({ code: 'batch_too_large', maxCommands: 50, message: expect.any(String) })
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
      [2, { sessionId: 'session', discountMinor: 1 }, 'sessionId: requires version 3'],
      [3, { customer: { customerId: 'x'.repeat(65) } }, 'customer.customerId: expected a string of at most 64 characters'],
      [1, { customer: { customerId: 'customer' } }, 'customer.customerId: requires version 3'],
    ])('rejects invalid v%s bookkeeping fields %j', async (version, fields, message) => {
      const sale = command()
      const response = await post([{ ...sale, version, payload: { ...sale.payload, ...fields } }])
      expect(response.status).toBe(200)
      expect(response.data.results[0]).toEqual({ id: sale.id, status: 'rejected', error: { code: 'invalid_payload', message } })
      expect(await liveOrders(sale.payload.clientOrderId)).toHaveLength(0)
    })
  },
})
