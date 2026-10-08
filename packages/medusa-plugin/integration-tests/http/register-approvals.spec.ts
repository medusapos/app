import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import type { MedusaContainer } from '@medusajs/framework/types'
import { Modules } from '@medusajs/framework/utils'
import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import type TallyRegisterModuleService from '../../src/modules/tally-register/service'

jest.setTimeout(180000)
const openedAt = '2026-01-01T08:00:00.000Z'
const closedAt = '2026-01-01T10:00:00.000Z'

medusaIntegrationTestRunner({
  cwd: path.resolve(__dirname, '../plugin-app'),
  testSuite: ({ api, getContainer }) => {
    let container: MedusaContainer
    let service: TallyRegisterModuleService
    let headers: Record<string, string>
    let manager: Awaited<ReturnType<typeof makeUser>>
    let opening: ReturnType<typeof open>

    async function makeUser(names = {}) {
      const email = `approval-${randomUUID()}@example.com`
      const password = 'integration-test-password'
      const user = await container.resolve(Modules.USER).createUsers({ email, ...names })
      const auth = container.resolve(Modules.AUTH)
      const { authIdentity, error } = await auth.register('emailpass', { body: { email, password } })
      expect(error).toBeUndefined()
      await auth.updateAuthIdentities({ id: authIdentity!.id, app_metadata: { user_id: user.id } })
      return { user, email, password }
    }
    async function cashier() {
      const { email, password } = await makeUser()
      const login = await api.post('/auth/user/emailpass', { email, password })
      expect(login.status).toBe(200)
      return { Authorization: `Bearer ${login.data.token}`, 'X-Tally-Protocol': '1' }
    }
    function command<P>(type: string, payload: P) {
      return { id: randomUUID(), type, version: 1, payload, createdAt: openedAt, deviceId: 'test-approval', attempt: 1 }
    }
    function open(registerId: string = randomUUID()) {
      return command('register.session.open', { sessionId: randomUUID(), registerId, openedAt, countedFloatMinor: 100 })
    }
    async function post(commands: unknown[]) {
      const response = await api.post('/tally/v1/commands', { commands }, { headers })
      expect(response.data.results.map(result => result.status)).toEqual(commands.map(() => 'applied'))
      return response
    }
    function approve(overrides = {}, actorHeaders = headers) {
      return api.post('/tally/v1/register-approvals', {
        sessionId: opening.payload.sessionId, variance: { cash: -20 }, email: manager.email, password: manager.password, ...overrides,
      }, { headers: actorHeaders, validateStatus: () => true })
    }
    beforeEach(async () => {
      container = getContainer()
      service = container.resolve('tally_register')
      headers = await cashier()
      manager = await makeUser({ first_name: 'Ada', last_name: 'Lovelace' })
      opening = open()
      await post([opening])
    })

    it('issues an opaque proof, stores only its hash and uses the database expiry and manager name', async () => {
      const before = Date.now()
      const response = await approve()
      expect(response.status).toBe(200)
      expect(response.data).toEqual({ approval: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        approvedBy: manager.user.id, approvedByName: 'Ada Lovelace', expiresAt: expect.any(String) })
      expect(response.headers['set-cookie']).toBeUndefined()
      expect(Date.parse(response.data.expiresAt)).toBeGreaterThanOrEqual(before + 15 * 60 * 1000 - 1000)
      expect(Date.parse(response.data.expiresAt)).toBeLessThanOrEqual(Date.now() + 15 * 60 * 1000 + 1000)
      const rows = await service.listTallyRegisterApprovals({ session_id: opening.payload.sessionId })
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ id: expect.stringMatching(/^apv_/),
        token_hash: createHash('sha256').update(response.data.approval).digest('hex'),
        session_id: opening.payload.sessionId, variance: { cash: -20 }, approved_by: manager.user.id,
        approved_by_name: 'Ada Lovelace', target_email: manager.email, used_at: null, closure_id: null })
      expect(new Date(rows[0].expires_at!).toISOString()).toBe(response.data.expiresAt)
      expect(JSON.stringify(rows)).not.toContain(response.data.approval)
      expect(JSON.stringify(rows)).not.toContain(manager.password)
    })

    it('uses the email when the approver has no names', async () => {
      const unnamed = await makeUser()
      const response = await approve({ email: unnamed.email, password: unnamed.password })
      expect(response.status).toBe(200)
      expect(response.data.approvedByName).toBe(unnamed.email)
    })

    it('stores the canonical session when approval names a resumed v2 alias', async () => {
      const canonical = { ...open(), version: 2 }
      const alias = { ...open(canonical.payload.registerId), version: 2 }
      const resumed = await post([canonical, alias])
      expect(resumed.data.results[1].register.resumed).toEqual({ fromSessionId: alias.payload.sessionId })
      const response = await approve({ sessionId: alias.payload.sessionId })
      expect(response.status).toBe(200)
      const [row] = await service.listTallyRegisterApprovals({ token_hash: createHash('sha256').update(response.data.approval).digest('hex') })
      expect(row.session_id).toBe(canonical.payload.sessionId)
    })

    it('accepts a closed session without a closure, then refuses one with a closure', async () => {
      const { sessionId, registerId } = opening.payload
      await post([command('register.session.transition', { sessionId, status: 'closed', at: closedAt, counted: { cash: 100 } })])
      expect((await approve()).status).toBe(200)
      await post([command('register.closure.submit', {
        closureId: randomUUID(), sessionId, registerId, number: 1, openedAt, closedAt,
        tillExpected: { cash: 100 }, counted: { cash: 100 }, periodSalesTotalMinor: 0, periodRefundsTotalMinor: 0,
        perpetualSalesTotalMinor: 0, perpetualRefundsTotalMinor: 0, unsyncedCount: 0, unsyncedTotalMinor: 0,
        softwareVersion: '1.0', orderIds: [], movementIds: [],
      })])
      const response = await approve()
      expect(response.status).toBe(409)
      expect(response.data).toEqual({ code: 'approval_session_closed', message: 'This register session is already closed.' })
      expect(await service.listTallyRegisterApprovals({ session_id: sessionId })).toHaveLength(1)
    })

    it('refuses an unknown session before checking credentials', async () => {
      const response = await approve({ sessionId: randomUUID(), password: 'wrong-password' })
      expect(response.status).toBe(409)
      expect(response.data).toEqual({ code: 'approval_session_unknown', message: 'This register session is not known to the store.' })
      expect(await service.listTallyRegisterApprovals({ target_email: manager.email })).toHaveLength(0)
    })

    it('uses the same credential error for a wrong password and an unknown email', async () => {
      const wrong = await approve({ password: 'wrong-password' })
      const unknown = await approve({ email: `${randomUUID()}@example.com` })
      expect([wrong.status, unknown.status]).toEqual([401, 401])
      expect(wrong.data).toEqual({ code: 'approval_invalid_credentials', message: "The manager's email or password is not correct." })
      expect(unknown.data).toEqual(wrong.data)
      const rows = await service.listTallyRegisterApprovals({ session_id: opening.payload.sessionId })
      expect(rows).toHaveLength(2)
      expect(rows.every(row => row.token_hash === null)).toBe(true)
      expect(JSON.stringify(rows)).not.toContain('wrong-password')
    })

    it.each([
      [{ variance: { card: 1 } }, 'variance.card: expected a payment method (cash or external)'],
      [{ variance: { cash: 1.5 } }, 'variance.cash: expected a safe integer'],
      [{ password: undefined }, 'password: expected a non-empty string'],
    ])('rejects invalid approval shape %j without admitting an attempt', async (body, message) => {
      const response = await approve(body)
      expect(response.status).toBe(400)
      expect(response.data).toEqual({ code: 'invalid_payload', message })
      expect(JSON.stringify(response.data)).not.toContain(manager.password)
      expect(await service.listTallyRegisterApprovals({ session_id: opening.payload.sessionId })).toHaveLength(0)
    })

    it('limits an actor after five failures, even with a correct password, and serves another actor', async () => {
      for (let i = 0; i < 5; i++) expect((await approve({ password: 'wrong-password' })).status).toBe(401)
      const response = await approve()
      expect(response.status).toBe(429)
      expect(response.data).toEqual({ code: 'approval_rate_limited', message: 'Too many failed approvals. Try again in a few minutes.' })
      expect(await service.listTallyRegisterApprovals({ target_email: manager.email })).toHaveLength(5)
      expect((await approve({}, await cashier())).status).toBe(200)
    })

    it('limits a normalized target email after ten failures across two actors', async () => {
      for (const actor of [headers, await cashier()]) {
        for (let i = 0; i < 5; i++) expect((await approve({
          email: i % 2 ? ` ${manager.email.toUpperCase()} ` : manager.email, password: 'wrong-password',
        }, actor)).status).toBe(401)
      }
      const response = await approve({}, await cashier())
      expect(response.status).toBe(429)
      expect(response.data.code).toBe('approval_rate_limited')
      expect(await service.listTallyRegisterApprovals({ target_email: manager.email })).toHaveLength(10)
    })

    it('atomically admits only five of eight parallel requests, including across sessions', async () => {
      const sessions = Array.from({ length: 8 }, () => open())
      await post(sessions)
      const responses = await Promise.all(sessions.map(session => approve({
        sessionId: session.payload.sessionId, password: 'wrong-password',
      })))
      expect(responses.filter(response => response.status === 401)).toHaveLength(5)
      expect(responses.filter(response => response.status === 429)).toHaveLength(3)
      expect(await service.listTallyRegisterApprovals({ target_email: manager.email })).toHaveLength(5)
    })

    it('successful approvals count toward neither the actor nor the email failure limit', async () => {
      for (const actor of [headers, await cashier()]) {
        for (let i = 0; i < 4; i++) expect((await approve({ password: 'wrong-password' }, actor)).status).toBe(401)
        expect((await approve({}, actor)).status).toBe(200)
        expect((await approve({ password: 'wrong-password' }, actor)).status).toBe(401)
      }
      const rows = await service.listTallyRegisterApprovals({ target_email: manager.email })
      expect(rows.filter(row => row.token_hash === null)).toHaveLength(10)
      expect(rows.filter(row => row.token_hash !== null)).toHaveLength(2)
    })

    it('requires a cashier token', async () => {
      const response = await approve({}, { 'X-Tally-Protocol': '1' })
      expect(response.status).toBe(401)
      expect(await service.listTallyRegisterApprovals({ target_email: manager.email })).toHaveLength(0)
    })
  },
})
