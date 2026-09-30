import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { MedusaContainer } from '@medusajs/framework/types'
import { ContainerRegistrationKeys, MedusaError, Modules } from '@medusajs/framework/utils'
import {
  convertDraftOrderWorkflow, createOrderPaymentCollectionWorkflow, createOrderWorkflow, markPaymentCollectionAsPaid,
  type CreateOrderWorkflowInput,
} from '@medusajs/medusa/core-flows'
import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import { TALLY_LEDGER_MODULE } from '../../src/modules/tally-ledger'
import type TallyLedgerModuleService from '../../src/modules/tally-ledger/service'
import { TALLY_REGISTER_MODULE } from '../../src/modules/tally-register'
import type TallyRegisterModuleService from '../../src/modules/tally-register/service'
import type { RegisterClosureSubmitPayload, RegisterSessionOpenPayload } from '../../src/modules/tally-register/types'
import { commandFingerprint } from '../../src/workflows/tally-order-create/fingerprint'
import { planOrderCreate } from '../../src/workflows/tally-order-create/plan'
import { loadSessionFigures } from '../../src/workflows/tally-register-command/figures'
import { seed } from './seed'

jest.setTimeout(180000)
const openedAt = '2026-01-01T08:00:00.000Z'
const closedAt = '2026-01-01T10:00:00.000Z'
const counters = { lastClosureNumber: 0, perpetualSalesTotalMinor: 0, perpetualRefundsTotalMinor: 0 }

medusaIntegrationTestRunner({
  cwd: path.resolve(__dirname, '../plugin-app'),
  testSuite: ({ api, getContainer }) => {
    let container: MedusaContainer
    let ledger: TallyLedgerModuleService
    let service: TallyRegisterModuleService
    let headers: Record<string, string>
    beforeEach(async () => {
      container = getContainer()
      ledger = container.resolve(TALLY_LEDGER_MODULE)
      service = container.resolve(TALLY_REGISTER_MODULE)
      const email = 'register-admin@example.com'
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

    function command<P>(type: string, payload: P) {
      return { id: randomUUID(), type, version: 1, payload, createdAt: openedAt, deviceId: 'test-register', attempt: 1 }
    }
    function open(registerId = randomUUID()) {
      return command('register.session.open', { sessionId: randomUUID(), registerId, openedAt, countedFloatMinor: 100 })
    }
    function close(sessionId: string) {
      return command('register.session.transition', { sessionId, status: 'closed', at: closedAt, counted: { cash: 100 } })
    }
    function closure(session: RegisterSessionOpenPayload, number = 1) {
      return command<RegisterClosureSubmitPayload>('register.closure.submit', {
        closureId: randomUUID(), sessionId: session.sessionId, registerId: session.registerId, number, openedAt, closedAt,
        tillExpected: { cash: 1100 }, counted: { cash: 1100 }, periodSalesTotalMinor: 1000, periodRefundsTotalMinor: 0,
        perpetualSalesTotalMinor: 1000, perpetualRefundsTotalMinor: 0, unsyncedCount: 0, unsyncedTotalMinor: 0,
        softwareVersion: '1.0', orderIds: [], movementIds: [],
      })
    }
    function post(commands: unknown[]) {
      return api.post('/tally/v1/commands', { commands }, { headers, validateStatus: () => true })
    }
    function sale(variantId: string, sessionId?: string, method = 'cash') {
      const clientLineId = randomUUID()
      return { ...command('order.create', {
        clientOrderId: randomUUID(), createdAt: openedAt, currency: 'EUR', pricesIncludeTax: true,
        ...(sessionId ? { sessionId } : {}),
        lines: [{ clientLineId, variantId, quantity: 1, unitPriceMinor: 1000 }],
        subtotalMinor: 840, taxMinor: 160, totalMinor: 1000,
        payments: [{ clientPaymentId: randomUUID(), method, amountMinor: 1000, tenderedMinor: 1200, changeMinor: 200 }],
        display: { currency: 'EUR', exponent: 2, taxInclusive: true, subtotalMinor: 1000,
          discountMinor: 0, taxMinor: 160, totalMinor: 1000, orderDiscountMinor: 0,
          lines: [{ clientLineId, amountMinor: 1000, discounts: [] }] },
        taxByRate: [{ ratePpm: 190000, code: 'VAT', netMinor: 840, taxMinor: 160, grossMinor: 1000 }],
      }), version: 3 }
    }
    function movement(sessionId: string, type: 'paid_in' | 'paid_out' | 'no_sale', amountMinor: number) {
      return command('register.movement.record', { movementId: randomUUID(), sessionId, type, amountMinor,
        reason: 'test movement', createdAt: openedAt })
    }

    it('opens a session: applied with register.session and counters, and a replay is a duplicate with the same register', async () => {
      const batch = [open()]
      const first = await post(batch)
      expect(first.status).toBe(200)
      expect(first.data.results).toEqual([{ id: batch[0].id, status: 'applied', register: {
        session: { id: batch[0].payload.sessionId, status: 'open', expected: { cash: 100 }, salesCount: 0 }, counters,
      } }])
      const replay = await post(batch)
      expect(replay.status).toBe(200)
      expect(replay.data.results).toEqual([{ ...first.data.results[0], status: 'duplicate' }])
    })

    it('a changed payload under the same command id is idempotency_mismatch', async () => {
      const opening = open()
      expect((await post([opening])).data.results[0].status).toBe('applied')
      const response = await post([{ ...opening, payload: { ...opening.payload, countedFloatMinor: 200 } }])
      expect(response.status).toBe(200)
      expect(response.data.results).toEqual([{ id: opening.id, status: 'rejected', error: {
        code: 'idempotency_mismatch', message: `Command ${opening.id} was already used for a different payload.`,
      } }])
    })

    it('a second open for the register is rejected register_session_already_open with data.sessionId, and its replay returns the same data', async () => {
      const opening = open()
      expect((await post([opening])).data.results[0].status).toBe('applied')
      const second = open(opening.payload.registerId)
      const response = await post([second])
      expect(response.status).toBe(200)
      expect(response.data.results[0]).toMatchObject({ id: second.id, status: 'rejected', error: {
        code: 'register_session_already_open', data: { sessionId: opening.payload.sessionId },
      } })
      const replay = await post([second])
      expect(replay.status).toBe(200)
      expect(replay.data.results).toEqual(response.data.results)
    })

    it('a replay of a stored rejection returns the recorded rejection after the state changes, and writes nothing', async () => {
      const opening = open()
      expect((await post([opening])).data.results[0].status).toBe('applied')
      const second = open(opening.payload.registerId)
      const response = await post([second])
      expect(response.status).toBe(200)
      expect(response.data.results[0]).toMatchObject({ id: second.id, status: 'rejected', error: {
        code: 'register_session_already_open', data: { sessionId: opening.payload.sessionId },
      } })
      const [stored] = await ledger.listTallyCommands({ id: second.id })
      expect(stored).toBeDefined()
      expect(stored.status).toBe('rejected')
      const updatedAt = stored.updated_at

      expect((await post([close(opening.payload.sessionId)])).data.results[0].status).toBe('applied')
      const replay = await post([second])
      expect(replay.status).toBe(200)
      expect(replay.data.results).toEqual(response.data.results)

      const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
      expect(await knex('tally_register_session').where('id', second.payload.sessionId)).toHaveLength(0)
      const [replayed] = await ledger.listTallyCommands({ id: second.id })
      expect(replayed).toBeDefined()
      expect(replayed.status).toBe(stored.status)
      expect(replayed.result).toEqual(stored.result)
      expect(replayed.updated_at).toEqual(updatedAt)
    })

    it('a movement on a closed session is rejected register_session_closed', async () => {
      const opening = open()
      const setup = await post([opening, close(opening.payload.sessionId)])
      expect(setup.data.results.map(result => result.status)).toEqual(['applied', 'applied'])
      const movement = command('register.movement.record', { movementId: randomUUID(), sessionId: opening.payload.sessionId,
        type: 'paid_out', amountMinor: 5, reason: 'payout', createdAt: closedAt })
      const response = await post([movement])
      expect(response.status).toBe(200)
      expect(response.data.results[0]).toMatchObject({ id: movement.id, status: 'rejected', error: { code: 'register_session_closed' } })
    })

    it('closure 1 is applied with closure.serverClosureId and counters; closure 3 is rejected register_closure_number_invalid with data.counters', async () => {
      const opening = open()
      const first = closure(opening.payload)
      const response = await post([opening, close(opening.payload.sessionId), first])
      expect(response.status).toBe(200)
      expect(response.data.results.map(result => result.status)).toEqual(['applied', 'applied', 'applied'])
      const expectedCounters = { ...counters, lastClosureNumber: 1, perpetualSalesTotalMinor: 1000 }
      expect(response.data.results[2]).toEqual({ id: first.id, status: 'applied', register: {
        closure: { serverClosureId: first.payload.closureId, number: 1, expected: { cash: 100 }, variance: { cash: 1000 } }, counters: expectedCounters,
      } })
      const replay = await post([first])
      expect(replay.data.results).toEqual([{ ...response.data.results[2], status: 'duplicate' }])
      const next = open(opening.payload.registerId)
      const invalid = closure(next.payload, 3)
      const rejected = await post([next, close(next.payload.sessionId), invalid])
      expect(rejected.status).toBe(200)
      expect(rejected.data.results[2]).toMatchObject({ id: invalid.id, status: 'rejected', error: {
        code: 'register_closure_number_invalid', data: { counters: expectedCounters },
      } })
      expect((await post([invalid])).data.results).toEqual([rejected.data.results[2]])
    })

    it('a second closure for the session is rejected register_closure_exists with data.closureId', async () => {
      const opening = open()
      const first = closure(opening.payload)
      const setup = await post([opening, close(opening.payload.sessionId), first])
      expect(setup.data.results.map(result => result.status)).toEqual(['applied', 'applied', 'applied'])
      const second = closure(opening.payload, 2)
      const response = await post([second])
      expect(response.status).toBe(200)
      expect(response.data.results[0]).toMatchObject({ id: second.id, status: 'rejected', error: {
        code: 'register_closure_exists', data: { closureId: first.payload.closureId },
      } })
      expect((await post([second])).data.results).toEqual(response.data.results)
    })

    it('a register payload shape error is invalid_payload and is not stored', async () => {
      const opening = open()
      const response = await post([{ ...opening, payload: { ...opening.payload, sessionId: undefined } }])
      expect(response.status).toBe(200)
      expect(response.data.results[0]).toMatchObject({ id: opening.id, status: 'rejected', error: {
        code: 'invalid_payload', message: expect.stringContaining('sessionId'),
      } })
      expect(await ledger.listTallyCommands({ id: opening.id })).toHaveLength(0)
      expect((await post([opening])).data.results[0].status).toBe('applied')
    })

    it('an unsupported register version is rejected unsupported_version with data.register 1 and is not stored', async () => {
      const opening = open()
      const response = await post([{ ...opening, version: 2 }])
      expect(response.status).toBe(200)
      expect(response.data.results[0]).toMatchObject({ id: opening.id, status: 'rejected', error: {
        code: 'unsupported_version', data: { register: 1 },
      } })
      expect(await ledger.listTallyCommands({ id: opening.id })).toHaveLength(0)
      expect((await post([opening])).data.results[0].status).toBe('applied')
    })

    it('order.create and register commands in one batch are both applied', async () => {
      const data = await seed(container)
      const sale = command('order.create', {
        clientOrderId: randomUUID(), createdAt: openedAt, currency: 'EUR', pricesIncludeTax: true,
        lines: [{ clientLineId: randomUUID(), variantId: data.variantA, quantity: 1, unitPriceMinor: 1000 }],
        subtotalMinor: 840, taxMinor: 160, totalMinor: 1000,
        payments: [{ clientPaymentId: randomUUID(), method: 'cash', amountMinor: 1000 }],
      })
      const opening = open()
      const response = await post([sale, opening])
      expect(response.status).toBe(200)
      expect(response.data.results.map(result => [result.id, result.status])).toEqual([[sale.id, 'applied'], [opening.id, 'applied']])
      expect(response.data.results[0].serverRefs.orderId).toEqual(expect.any(String))
      expect(response.data.results[1].register.session.id).toBe(opening.payload.sessionId)
    })

    it('a register write whose ledger completion failed is retried as applied, not refused', async () => {
      const opening = open()
      jest.spyOn(ledger, 'complete').mockRejectedValueOnce(new Error('completion failed'))
      const failed = await post([opening])
      expect(failed.status).toBe(503)
      expect(failed.data).toEqual({ code: 'transient', id: opening.id, message: 'Temporary failure, retry later.' })
      const stored = await service.registerState(opening.payload.registerId)
      expect(stored?.session).toEqual({ id: opening.payload.sessionId, status: 'open' })
      expect(await ledger.listTallyCommands({ id: opening.id })).toHaveLength(0)
      const retry = await post([opening])
      expect(retry.status).toBe(200)
      expect(retry.data.results).toEqual([{ id: opening.id, status: 'applied', register: {
        ...stored, session: { ...stored!.session, expected: { cash: 100 }, salesCount: 0 },
      } }])
      expect((await post([opening])).data.results).toEqual([{ ...retry.data.results[0], status: 'duplicate' }])
    })

    it('/info lists order.create 1, 2, 3 and register 1', async () => {
      const response = await api.get('/tally/v1/info', { headers })
      expect(response.status).toBe(200)
      expect(response.data).toEqual({
        contracts: { 'order.create': [1, 2, 3], register: [1], sync: [1] },
        taxRounding: { granularity: 'per_order', mode: 'half_away_from_zero' },
      })
    })

    it('records and voids a movement and replays every result through the ledger', async () => {
      const opening = open()
      const movement = command('register.movement.record', { movementId: randomUUID(), sessionId: opening.payload.sessionId,
        type: 'paid_out', amountMinor: 5, reason: 'payout', createdAt: openedAt })
      const voiding = command('register.movement.void', { movementId: randomUUID(), sessionId: opening.payload.sessionId,
        voids: movement.payload.movementId, createdAt: openedAt })
      const batch = [opening, movement, voiding]
      const response = await post(batch)
      expect(response.status).toBe(200)
      expect(response.data.results.map(result => result.status)).toEqual(['applied', 'applied', 'applied'])
      expect((await post(batch)).data.results).toEqual(response.data.results.map(result => ({ ...result, status: 'duplicate' })))
    })

    it('live expected counts every completed order carrying the sessionId, plus float and movements', async () => {
      const data = await seed(container)
      const opening = open()
      const sessionId = opening.payload.sessionId
      const cash = sale(data.variantB, sessionId)
      const external = sale(data.variantB, sessionId, 'external')
      const unrelated = sale(data.variantB, randomUUID())
      const paidIn = movement(sessionId, 'paid_in', 200)
      const paidOut = movement(sessionId, 'paid_out', 50)
      const voided = movement(sessionId, 'paid_out', 70)
      const voiding = command('register.movement.void', { movementId: randomUUID(), sessionId,
        voids: voided.payload.movementId, createdAt: openedAt })
      const counting = command('register.session.transition', { sessionId, status: 'counting', at: closedAt })
      const batch = [opening, cash, external, unrelated, paidIn, paidOut, voided, voiding,
        movement(sessionId, 'no_sale', 0), counting]
      const response = await post(batch)
      expect(response.status).toBe(200)
      expect(response.data.results.map(result => result.status)).toEqual(batch.map(() => 'applied'))
      expect(response.data.results.filter(result => result.register).map(result => result.register.session)).toEqual([
        { id: sessionId, status: 'open', expected: { cash: 100 }, salesCount: 0 },
        ...[1300, 1250, 1180, 1250, 1250].map(cash => ({
          id: sessionId, status: 'open', expected: { cash, external: 1000 }, salesCount: 2,
        })),
        { id: sessionId, status: 'counting', expected: { cash: 1250, external: 1000 }, salesCount: 2 },
      ])
      expect((await post([opening, paidIn])).data.results).toEqual([
        { ...response.data.results[0], status: 'duplicate' }, { ...response.data.results[4], status: 'duplicate' },
      ])
    })

    it('a rejected session sale and its retry count cash once in the live and closed figures', async () => {
      const data = await seed(container)
      const opening = open()
      const sessionId = opening.payload.sessionId
      const order = sale(data.variantB, sessionId)
      expect((await post([opening])).data.results[0].status).toBe('applied')
      const planned = planOrderCreate(order.payload as Parameters<typeof planOrderCreate>[0], {
        customer: null, commandId: order.id, salesChannelId: data.channelId,
        region: { id: data.regionId, currency_code: 'eur', country_codes: ['de', 'dk'] },
        location: { id: data.berlinId, address: { address_1: 'Alexanderplatz 1', city: 'Berlin', country_code: 'de', postal_code: '10178' } },
        variants: { [data.variantB]: { id: data.variantB } },
      })
      if (!planned.ok) throw new Error('Expected a plan')
      const { result: draft } = await createOrderWorkflow(container).run({ input: planned.plan.draftOrder as unknown as CreateOrderWorkflowInput })
      await convertDraftOrderWorkflow(container).run({ input: { id: draft.id } })
      const { result: [collection] } = await createOrderPaymentCollectionWorkflow(container).run({
        input: { order_id: draft.id, amount: order.payload.totalMinor / 100 },
      })
      await markPaymentCollectionAsPaid(container).run({ input: { order_id: draft.id, payment_collection_id: collection.id } })
      await container.resolve(Modules.PAYMENT).updatePaymentCollections(collection.id, { status: 'partially_captured' })
      const parked = await post([order])
      expect([parked.status, parked.data]).toEqual([409, { code: 'in_progress', id: order.id }])
      expect(await ledger.retrieveTallyCommand(order.id)).toMatchObject({ status: 'needs_admin' })
      const script = require('../../.medusa/server/src/scripts/tally-ledger-resolve') as typeof import('../../src/scripts/tally-ledger-resolve')
      await script.default({ container, args: [order.id, 'reject'] })
      const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
      expect(await knex('order').where({ id: draft.id }).first()).toMatchObject({ status: 'canceled', metadata: {
        tally_rejected: true, tally_session_id: sessionId, tally_payments: order.payload.payments,
      } })
      expect(await loadSessionFigures(container, sessionId)).toEqual({ expected: { cash: 100 }, salesCount: 0 })
      const retry = await post([{ ...order, id: randomUUID() }])
      expect([retry.status, retry.data.results[0].status]).toEqual([200, 'applied'])
      expect(retry.data.results[0].serverRefs.orderId).not.toBe(draft.id)
      expect(await loadSessionFigures(container, sessionId)).toEqual({ expected: { cash: 1100 }, salesCount: 1 })
      const applied = await knex('order').where({ id: retry.data.results[0].serverRefs.orderId }).first()
      expect(applied.metadata).not.toHaveProperty('tally_rejected')
      const submission = closure(opening.payload)
      submission.payload.orderIds = [order.payload.clientOrderId]
      const closed = await post([close(sessionId), submission])
      expect(closed.status).toBe(200)
      expect(closed.data.results.map(result => result.status)).toEqual(['applied', 'applied'])
      expect(closed.data.results[1].register.closure).toMatchObject({ expected: { cash: 1100 }, variance: { cash: 0 } })
    })

    it('rejecting a new command for a sale marks only its parked order, and the order an admin canceled by hand still counts once', async () => {
      const data = await seed(container)
      const opening = open()
      const sessionId = opening.payload.sessionId
      const first = sale(data.variantB, sessionId)
      const applied = await post([opening, first])
      expect(applied.data.results.map(result => result.status)).toEqual(['applied', 'applied'])
      const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
      const handCanceled = applied.data.results[1].serverRefs.orderId
      await knex('order').where({ id: handCanceled }).update({ status: 'canceled' })
      expect(await loadSessionFigures(container, sessionId)).toEqual({ expected: { cash: 1100 }, salesCount: 1 })
      const order = { ...first, id: randomUUID() }
      const planned = planOrderCreate(order.payload as Parameters<typeof planOrderCreate>[0], {
        customer: null, commandId: order.id, salesChannelId: data.channelId,
        region: { id: data.regionId, currency_code: 'eur', country_codes: ['de', 'dk'] },
        location: { id: data.berlinId, address: { address_1: 'Alexanderplatz 1', city: 'Berlin', country_code: 'de', postal_code: '10178' } },
        variants: { [data.variantB]: { id: data.variantB } },
      })
      if (!planned.ok) throw new Error('Expected a plan')
      const { result: draft } = await createOrderWorkflow(container).run({ input: planned.plan.draftOrder as unknown as CreateOrderWorkflowInput })
      await convertDraftOrderWorkflow(container).run({ input: { id: draft.id } })
      const { result: [collection] } = await createOrderPaymentCollectionWorkflow(container).run({
        input: { order_id: draft.id, amount: order.payload.totalMinor / 100 },
      })
      await markPaymentCollectionAsPaid(container).run({ input: { order_id: draft.id, payment_collection_id: collection.id } })
      await container.resolve(Modules.PAYMENT).updatePaymentCollections(collection.id, { status: 'partially_captured' })
      const parked = await post([order])
      expect([parked.status, parked.data]).toEqual([409, { code: 'in_progress', id: order.id }])
      expect(await ledger.retrieveTallyCommand(order.id)).toMatchObject({ status: 'needs_admin', needs_admin_reason: { orderId: draft.id } })
      const script = require('../../.medusa/server/src/scripts/tally-ledger-resolve') as typeof import('../../src/scripts/tally-ledger-resolve')
      await script.default({ container, args: [order.id, 'reject'] })
      expect(await knex('order').where({ id: draft.id }).first()).toMatchObject({ status: 'canceled', metadata: { tally_rejected: true } })
      const kept = await knex('order').where({ id: handCanceled }).first()
      expect(kept.status).toBe('canceled')
      expect(kept.metadata).not.toHaveProperty('tally_rejected')
      expect(await loadSessionFigures(container, sessionId)).toEqual({ expected: { cash: 1100 }, salesCount: 1 })
      const submission = closure(opening.payload)
      submission.payload.orderIds = [first.payload.clientOrderId]
      const closed = await post([close(sessionId), submission])
      expect(closed.data.results.map(result => result.status)).toEqual(['applied', 'applied'])
      expect(closed.data.results[1].register.closure).toMatchObject({ expected: { cash: 1100 }, variance: { cash: 0 } })
    })

    it('a failed order.create leaves no session order or cash figure, and its retry counts the sale once', async () => {
      const data = await seed(container)
      const opening = open()
      const sessionId = opening.payload.sessionId
      const order = sale(data.variantB, sessionId)
      expect((await post([opening])).data.results[0].status).toBe('applied')
      const before = await loadSessionFigures(container, sessionId)
      expect(before).toEqual({ expected: { cash: 100 }, salesCount: 0 })
      jest.spyOn(container.resolve(Modules.ORDER), 'completeOrder').mockRejectedValueOnce(new Error('complete probe'))
      expect((await post([order])).status).toBe(503)
      const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
      expect(await knex('order').whereRaw("metadata->>'tally_client_id' = ?", [order.payload.clientOrderId])).toEqual([])
      expect(await loadSessionFigures(container, sessionId)).toEqual(before)
      const retry = await post([order])
      expect([retry.status, retry.data.results[0].status]).toEqual([200, 'applied'])
      expect(await loadSessionFigures(container, sessionId)).toEqual({ expected: { cash: 1100 }, salesCount: 1 })
    })

    it("closure expected counts the closure's orderIds, including an order sent without sessionId, and excludes a session order not in orderIds", async () => {
      const data = await seed(container)
      const opening = open()
      const sessionId = opening.payload.sessionId
      const included = sale(data.variantB, sessionId)
      const withoutSession = sale(data.variantB)
      const otherSession = sale(data.variantB, randomUUID(), 'external')
      const excluded = sale(data.variantB, sessionId)
      const submission = closure(opening.payload)
      submission.payload.orderIds = [included, withoutSession, otherSession].map(order => order.payload.clientOrderId)
      const batch = [opening, included, withoutSession, otherSession, excluded, close(sessionId), submission]
      const response = await post(batch)
      expect(response.status).toBe(200)
      expect(response.data.results.map(result => result.status)).toEqual(batch.map(() => 'applied'))
      expect(response.data.results[6].register.closure).toEqual({ serverClosureId: submission.payload.closureId,
        number: 1, expected: { cash: 2100, external: 1000 }, variance: { cash: -1000 } })
      const after = await post([close(sessionId)])
      expect(after.data.results[0].register.session).toEqual({ id: sessionId, status: 'closed',
        expected: { cash: 2100, external: 1000 }, salesCount: 3 })
      const read = await api.get(`/tally/v1/registers/${opening.payload.registerId}`, { headers })
      expect(read.data.session).toEqual(after.data.results[0].register.session)
    })

    it.each([
      { action: 'archiving', status: 'archived' },
      { action: 'cancelling', status: 'canceled' },
    ])('$action an order after the closure changes neither the live nor the closed figure', async ({ status }) => {
      const data = await seed(container)
      const opening = open()
      const liveOpening = open()
      const sessionId = opening.payload.sessionId
      const liveSessionId = liveOpening.payload.sessionId
      const order = sale(data.variantB, sessionId)
      const liveOrder = sale(data.variantB, liveSessionId)
      const batch = [opening, liveOpening, order, liveOrder]
      const response = await post(batch)
      expect(response.status).toBe(200)
      expect(response.data.results.map(result => result.status)).toEqual(batch.map(() => 'applied'))
      const read = await api.get(`/tally/v1/registers/${opening.payload.registerId}`, { headers })
      expect(read.data.session).toEqual({ id: sessionId, status: 'open', expected: { cash: 1100 }, salesCount: 1 })
      const liveBefore = await loadSessionFigures(container, liveSessionId)
      expect(liveBefore).toEqual({ expected: read.data.session.expected, salesCount: 1 })
      const submission = closure(opening.payload)
      submission.payload.orderIds = [order.payload.clientOrderId]
      const closed = await post([close(sessionId), submission])
      expect(closed.status).toBe(200)
      expect(closed.data.results.map(result => result.status)).toEqual(['applied', 'applied'])
      const closedBefore = await loadSessionFigures(container, sessionId)
      expect(closedBefore).toEqual({ ...liveBefore, variance: { cash: 0 } })
      expect(closed.data.results[1].register.closure.expected).toEqual(closedBefore!.expected)
      const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
      await knex('order').whereIn('id', response.data.results.slice(2).map(result => result.serverRefs.orderId))
        .update({ status })
      expect(await loadSessionFigures(container, sessionId)).toEqual(closedBefore)
      expect(await loadSessionFigures(container, liveSessionId)).toEqual(liveBefore)
    })

    it("closure variance is counted minus server expected over counted's keys, and the till's tillExpected and counted are stored unchanged", async () => {
      const data = await seed(container)
      const opening = open()
      const sessionId = opening.payload.sessionId
      const cash = sale(data.variantB, sessionId)
      const external = sale(data.variantB, sessionId, 'external')
      const submission = closure(opening.payload)
      submission.payload.orderIds = [cash, external].map(order => order.payload.clientOrderId)
      submission.payload.tillExpected = { cash: 9000, external: 8000 }
      submission.payload.counted = { cash: 1050 }
      const batch = [opening, cash, external, close(sessionId), submission]
      const response = await post(batch)
      expect(response.status).toBe(200)
      expect(response.data.results.map(result => result.status)).toEqual(batch.map(() => 'applied'))
      const expectedClosure = { serverClosureId: submission.payload.closureId, number: 1,
        expected: { cash: 1100, external: 1000 }, variance: { cash: -50 } }
      expect(response.data.results[4].register.closure).toEqual(expectedClosure)
      const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
      const stored = await knex('tally_register_closure').where('id', submission.payload.closureId).first()
      expect(stored.till_expected).toEqual(submission.payload.tillExpected)
      expect(stored.counted).toEqual(submission.payload.counted)
      expect(stored.expected).toBeNull()
      expect(stored.variance).toBeNull()
      const retry = await post([{ ...submission, id: randomUUID(), payload: {
        ...submission.payload, counted: { cash: 9999 }, tillExpected: { cash: 9999 },
      } }])
      expect(retry.data.results[0].register.closure).toEqual(expectedClosure)
      expect(await knex('tally_register_closure').where('id', submission.payload.closureId).first()).toEqual(stored)
    })

    it('a closure.submit counting a voucher is refused unstored as invalid_payload, and no closure is stored (ruling 17)', async () => {
      const opening = open()
      const submission = closure(opening.payload)
      submission.payload.counted = { cash: 1100, voucher: 0 }
      const response = await post([opening, close(opening.payload.sessionId), submission])
      expect(response.status).toBe(200)
      expect(response.data.results.map(result => result.status)).toEqual(['applied', 'applied', 'rejected'])
      expect(response.data.results[2]).toEqual({ id: submission.id, status: 'rejected', error: {
        code: 'invalid_payload', message: 'payload.counted.voucher: expected a payment method (cash or external)',
      } })
      expect(await ledger.listTallyCommands({ id: submission.id }, { withDeleted: true })).toHaveLength(0)
      const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
      expect(await knex('tally_register_closure').where('id', submission.payload.closureId)).toHaveLength(0)
    })

    it('a closure.submit with envelope.priority is refused unstored as invalid_payload, and no closure is stored (ruling 17)', async () => {
      const opening = open()
      const submission = { ...closure(opening.payload), priority: 1 }
      const response = await post([opening, close(opening.payload.sessionId), submission])
      expect(response.status).toBe(200)
      expect(response.data.results.map(result => result.status)).toEqual(['applied', 'applied', 'rejected'])
      expect(response.data.results[2]).toEqual({ id: submission.id, status: 'rejected', error: {
        code: 'invalid_payload', message: 'envelope.priority: unknown field for register.closure.submit version 1',
      } })
      expect(await ledger.listTallyCommands({ id: submission.id }, { withDeleted: true })).toHaveLength(0)
      const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
      expect(await knex('tally_register_closure').where('id', submission.payload.closureId)).toHaveLength(0)
    })

    it('a closure.submit whose payload.closedAt is over 24 hours ahead, between two good commands, is refused alone, unstored (TallyUI #325)', async () => {
      const opening = open()
      const submission = closure(opening.payload)
      submission.payload.closedAt = new Date(Date.now() + 24 * 60 * 60 * 1000 + 60000).toISOString()
      const beforeRequest = Date.now()
      const response = await post([opening, submission, close(opening.payload.sessionId)])
      const afterRequest = Date.now()
      expect(response.status).toBe(200)
      expect(response.data.results.map(result => result.status)).toEqual(['applied', 'rejected', 'applied'])
      const pattern = /^payload\.closedAt must be a time from 2020-01-01T00:00:00Z to (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ)$/
      expect(response.data.results[1]).toEqual({ id: submission.id, status: 'rejected', error: { code: 'invalid_payload',
        message: expect.stringMatching(pattern) } })
      const upperBound = Date.parse(pattern.exec(response.data.results[1].error.message)![1])
      expect(upperBound).toBeGreaterThanOrEqual(Math.floor((beforeRequest + 24 * 60 * 60 * 1000) / 1000) * 1000)
      expect(upperBound).toBeLessThanOrEqual(Math.floor((afterRequest + 24 * 60 * 60 * 1000) / 1000) * 1000)
      expect(await ledger.listTallyCommands({ id: submission.id }, { withDeleted: true })).toHaveLength(0)
      const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
      expect(await knex('tally_register_closure').where('id', submission.payload.closureId)).toHaveLength(0)
    })

    it('refuses a zone-less payload.closedAt before writing a ledger row', async () => {
      const submission = closure(open().payload)
      submission.payload.closedAt = '2026-09-30T12:00:00'
      const response = await post([submission])
      expect(response.status).toBe(200)
      expect(response.data.results).toEqual([{ id: submission.id, status: 'rejected', error: {
        code: 'invalid_payload', message: 'payload.closedAt must be an RFC 3339 time with Z or an offset',
      } }])
      expect(await ledger.listTallyCommands({ id: submission.id }, { withDeleted: true })).toHaveLength(0)
      const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
      expect(await knex('tally_register_closure').where('id', submission.payload.closureId)).toHaveLength(0)
    })

    it.each(['2019-12-31T23:59:59.999Z', 'invalid', '2026-09-30T12:00:00'])(
      'shape wins over client-time format and bounds (%s) for a closure with an unknown payload field', async value => {
        const submission = closure(open().payload)
        const response = await post([{ ...submission, payload: { ...submission.payload,
          closedAt: value, unknown: true } }])
        expect(response.status).toBe(200)
        expect(response.data.results).toEqual([{ id: submission.id, status: 'rejected', error: {
          code: 'invalid_payload', message: 'payload.unknown: unknown field for register.closure.submit version 1',
        } }])
        expect(await ledger.listTallyCommands({ id: submission.id }, { withDeleted: true })).toHaveLength(0)
      })

    it('an applied closure resent with an envelope.createdAt before 2020 answers duplicate, because the replay read comes first', async () => {
      const opening = open()
      const submission = closure(opening.payload)
      const applied = await post([opening, close(opening.payload.sessionId), submission])
      expect(applied.data.results.map(result => result.status)).toEqual(['applied', 'applied', 'applied'])
      const response = await post([{ ...submission, attempt: 2, createdAt: '2019-12-31T23:59:59.999Z' }])
      expect(response.status).toBe(200)
      expect(response.data.results).toEqual([{ ...applied.data.results[2], status: 'duplicate' }])
    })

    it('an orderId the server has not received is missing from the closure figure, and no extra field appears', async () => {
      const data = await seed(container)
      const opening = open()
      const sessionId = opening.payload.sessionId
      const received = sale(data.variantB, sessionId)
      const late = sale(data.variantB)
      const submission = closure(opening.payload)
      submission.payload.orderIds = [received, late].map(order => order.payload.clientOrderId)
      submission.payload.tillExpected = { cash: 2100 }
      submission.payload.unsyncedCount = 1
      submission.payload.unsyncedTotalMinor = 1000
      const response = await post([opening, received, close(sessionId), submission])
      expect(response.status).toBe(200)
      expect(response.data.results.map(result => result.status)).toEqual(['applied', 'applied', 'applied', 'applied'])
      expect(response.data.results[3].register).toEqual({
        closure: { serverClosureId: submission.payload.closureId, number: 1, expected: { cash: 1100 }, variance: { cash: 0 } },
        counters: { ...counters, lastClosureNumber: 1, perpetualSalesTotalMinor: 1000 },
      })
      const url = `/tally/v1/registers/${opening.payload.registerId}`
      expect((await api.get(url, { headers })).data.session).toEqual({ id: sessionId, status: 'closed',
        expected: { cash: 1100 }, salesCount: 1 })
      expect((await post([late])).data.results[0].status).toBe('applied')
      expect((await api.get(url, { headers })).data.session).toEqual({ id: sessionId, status: 'closed',
        expected: { cash: 2100 }, salesCount: 2 })
      expect((await post([submission])).data.results).toEqual([{ ...response.data.results[3], status: 'duplicate' }])
      const refreshed = await post([{ ...submission, id: randomUUID() }])
      expect(refreshed.data.results[0].register.closure).toEqual({ serverClosureId: submission.payload.closureId,
        number: 1, expected: { cash: 2100 }, variance: { cash: -1000 } })
      const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
      const stored = await knex('tally_register_closure').where('id', submission.payload.closureId).first()
      expect(stored.unsynced_count).toBe(1)
      expect(Number(stored.unsynced_total_minor)).toBe(1000)
      expect(stored.till_expected).toEqual({ cash: 2100 })
      expect(stored.counted).toEqual({ cash: 1100 })
      expect(stored.expected).toBeNull()
      expect(stored.variance).toBeNull()
    })

    it('a movement recorded before the closure but absent from movementIds is excluded from the closure figure', async () => {
      const data = await seed(container)
      const opening = open()
      const sessionId = opening.payload.sessionId
      const included = movement(sessionId, 'paid_in', 200)
      const stranded = movement(sessionId, 'paid_in', 300)
      const voided = movement(sessionId, 'paid_out', 70)
      const voiding = command('register.movement.void', { movementId: randomUUID(), sessionId,
        voids: voided.payload.movementId, createdAt: openedAt })
      const submission = closure(opening.payload)
      submission.payload.movementIds = [included.payload.movementId, voided.payload.movementId]
      expect((await post([sale(data.variantB, sessionId)])).data.results[0].status).toBe('applied')
      const batch = [opening, included, stranded, voided, voiding, close(sessionId), submission]
      const response = await post(batch)
      expect(response.status).toBe(200)
      expect(response.data.results.map(result => result.status)).toEqual(batch.map(() => 'applied'))
      expect(response.data.results[5].register.session).toEqual({ id: sessionId, status: 'closed',
        expected: { cash: 1600 }, salesCount: 1 })
      expect(response.data.results[6].register.closure).toEqual({ serverClosureId: submission.payload.closureId,
        number: 1, expected: { cash: 300 }, variance: { cash: 800 } })
      const read = await api.get(`/tally/v1/registers/${opening.payload.registerId}`, { headers })
      expect(read.data.session).toEqual({ id: sessionId, status: 'closed', expected: { cash: 300 }, salesCount: 0 })
    })

    it('GET /tally/v1/registers/{id} returns the open session with expected and salesCount and the counters; 404 for an unknown register; 401 without auth', async () => {
      const data = await seed(container)
      const opening = open()
      const response = await post([opening, sale(data.variantB, opening.payload.sessionId)])
      expect(response.data.results.map(result => result.status)).toEqual(['applied', 'applied'])
      const url = `/tally/v1/registers/${opening.payload.registerId}`
      const read = await api.get(url, { headers: { ...headers, Origin: 'http://localhost' } })
      expect(read.status).toBe(200)
      expect(read.headers['access-control-allow-origin']).toBe('http://localhost')
      expect(read.headers['access-control-allow-credentials']).toBe('true')
      expect(read.data).toEqual({ session: { id: opening.payload.sessionId, status: 'open',
        expected: { cash: 1100 }, salesCount: 1 }, counters })
      const unknown = await api.get(`/tally/v1/registers/${randomUUID()}`, { headers, validateStatus: () => true })
      expect(unknown.status).toBe(404)
      expect(unknown.data).toEqual({ message: 'Unknown register' })
      expect((await api.get(url, { validateStatus: () => true })).status).toBe(401)
    })

    it('a state-dependent refusal is invalid_payload and is not stored, so a resend after the fix applies', async () => {
      const opening = open()
      const recording = movement(opening.payload.sessionId, 'paid_in', 50)
      const response = await post([recording])
      expect(response.status).toBe(200)
      expect(response.data.results).toEqual([{ id: recording.id, status: 'rejected', error: { code: 'invalid_payload', message: 'unknown session' } }])
      expect(await ledger.listTallyCommands({ id: recording.id })).toHaveLength(0)
      expect((await post([opening])).data.results[0].status).toBe('applied')
      const resend = await post([recording])
      expect(resend.status).toBe(200)
      expect(resend.data.results[0]).toMatchObject({ id: recording.id, status: 'applied' })
    })

    it('a register command whose claim was lost before the write is in_progress and writes nothing', async () => {
      const opening = open()
      jest.spyOn(ledger, 'assertClaim').mockRejectedValueOnce(new MedusaError(MedusaError.Types.CONFLICT, 'claim lost'))
      const response = await post([opening])
      expect(response.status).toBe(409)
      expect(response.data).toEqual({ code: 'in_progress', id: opening.id })
      const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
      expect(await knex('tally_register_session').where('id', opening.payload.sessionId)).toHaveLength(0)
      expect(await ledger.listTallyCommands({ id: opening.id })).toHaveLength(0)
    })

    describe('step order: a recorded id answers its recorded result before the version and shape rules', () => {
      // Records `result` for `envelope` directly, as a command the server accepted before ruling 17 could be.
      async function record(envelope: { id: string; type: string; version: number; payload: unknown },
        result: Parameters<TallyLedgerModuleService['complete']>[2]) {
        const fingerprint = commandFingerprint(envelope as unknown as Parameters<typeof commandFingerprint>[0])
        const claim = await ledger.claim({ id: envelope.id, type: envelope.type, fingerprint })
        if (!claim.claimed) throw new Error('Expected a fresh claim')
        await ledger.complete(envelope.id, claim.claimToken, { ...result, id: envelope.id })
      }
      async function closeDay() {
        const opening = open()
        const submission = closure(opening.payload)
        const response = await post([opening, close(opening.payload.sessionId), submission])
        expect(response.data.results.map(result => result.status)).toEqual(['applied', 'applied', 'applied'])
        return { opening, submission, applied: response.data.results[2] }
      }

      it.each([
        { label: 'an unknown field', change: (payload: RegisterClosureSubmitPayload) => ({ ...payload, note: 'end of day' }), version: 1 },
        { label: 'an unknown counted key', change: (payload: RegisterClosureSubmitPayload) => ({ ...payload, counted: { cash: 1100, card: 0 } }), version: 1 },
        { label: 'an unsupported version', change: (payload: RegisterClosureSubmitPayload) => payload, version: 2 },
      ])('a close recorded as applied, resent with $label, answers duplicate with its recorded result', async ({ change, version }) => {
        const { submission, applied } = await closeDay()
        const resend = { ...submission, id: randomUUID(), version, payload: change(submission.payload) }
        await record(resend, applied)
        const response = await post([resend])
        expect(response.status).toBe(200)
        expect(response.data.results).toEqual([{ ...applied, id: resend.id, status: 'duplicate' }])
      })

      it('a close recorded as rejected, resent with an unknown field, answers its recorded rejection', async () => {
        const { opening } = await closeDay()
        const second = closure(opening.payload, 2)
        const rejected = (await post([second])).data.results[0]
        expect(rejected).toMatchObject({ status: 'rejected', error: { code: 'register_closure_exists' } })
        const resend = { ...second, id: randomUUID(), payload: { ...second.payload, note: 'end of day' } }
        await record(resend, rejected)
        const response = await post([resend])
        expect(response.status).toBe(200)
        expect(response.data.results).toEqual([{ ...rejected, id: resend.id }])
      })
    })
  },
})
