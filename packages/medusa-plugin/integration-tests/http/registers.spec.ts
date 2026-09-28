import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { MedusaContainer } from '@medusajs/framework/types'
import { ContainerRegistrationKeys, MedusaError, Modules } from '@medusajs/framework/utils'
import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import { TALLY_LEDGER_MODULE } from '../../src/modules/tally-ledger'
import type TallyLedgerModuleService from '../../src/modules/tally-ledger/service'
import { TALLY_REGISTER_MODULE } from '../../src/modules/tally-register'
import type TallyRegisterModuleService from '../../src/modules/tally-register/service'
import type { RegisterClosureSubmitPayload, RegisterSessionOpenPayload } from '../../src/modules/tally-register/types'
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
      expect(response.data).toEqual({ contracts: { 'order.create': [1, 2, 3], register: [1] } })
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
  },
})
