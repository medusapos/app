import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { MedusaContainer } from '@medusajs/framework/types'
import { Modules } from '@medusajs/framework/utils'
import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import { TALLY_LEDGER_MODULE } from '../../src/modules/tally-ledger'
import type TallyLedgerModuleService from '../../src/modules/tally-ledger/service'
import { TALLY_REGISTER_MODULE } from '../../src/modules/tally-register'
import type TallyRegisterModuleService from '../../src/modules/tally-register/service'
import type { RegisterSessionOpenPayload } from '../../src/modules/tally-register/types'
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
      return command('register.closure.submit', {
        closureId: randomUUID(), sessionId: session.sessionId, registerId: session.registerId, number, openedAt, closedAt,
        tillExpected: { cash: 1100 }, counted: { cash: 1100 }, periodSalesTotalMinor: 1000, periodRefundsTotalMinor: 0,
        perpetualSalesTotalMinor: 1000, perpetualRefundsTotalMinor: 0, unsyncedCount: 0, unsyncedTotalMinor: 0,
        softwareVersion: '1.0', orderIds: [], movementIds: [],
      })
    }
    function post(commands: unknown[]) {
      return api.post('/tally/v1/commands', { commands }, { headers, validateStatus: () => true })
    }

    it('opens a session: applied with register.session and counters, and a replay is a duplicate with the same register', async () => {
      const batch = [open()]
      const first = await post(batch)
      expect(first.status).toBe(200)
      expect(first.data.results).toEqual([{ id: batch[0].id, status: 'applied', register: {
        session: { id: batch[0].payload.sessionId, status: 'open' }, counters,
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
        closure: { serverClosureId: first.payload.closureId, number: 1 }, counters: expectedCounters,
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
      expect(retry.data.results).toEqual([{ id: opening.id, status: 'applied', register: stored }])
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

    it('stores service invalid_payload outcomes so a replay keeps the original rejection', async () => {
      const transition = close(randomUUID())
      const response = await post([transition])
      expect(response.status).toBe(200)
      expect(response.data.results).toEqual([{ id: transition.id, status: 'rejected', error: { code: 'invalid_payload', message: 'unknown session' } }])
      expect(await ledger.listTallyCommands({ id: transition.id })).toHaveLength(1)
      expect((await post([transition])).data.results).toEqual(response.data.results)
    })
  },
})
