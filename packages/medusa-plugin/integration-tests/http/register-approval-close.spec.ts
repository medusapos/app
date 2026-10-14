import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import type { MedusaContainer } from '@medusajs/framework/types'
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import type { RegisterClosureSubmitV3Payload, RegisterSessionOpenPayload } from '../../src/modules/tally-register/types'

jest.setTimeout(180000)
const openedAt = '2026-01-01T08:00:00.000Z'
const closedAt = '2026-01-01T10:00:00.000Z'

medusaIntegrationTestRunner({
  cwd: path.resolve(__dirname, '../plugin-app'),
  testSuite: ({ api, getContainer }) => {
    let container: MedusaContainer
    let headers: Record<string, string>
    let manager: Awaited<ReturnType<typeof makeUser>>
    let opening: ReturnType<typeof open>

    async function makeUser() {
      const email = `approval-close-${randomUUID()}@example.com`
      const password = 'integration-test-password'
      const user = await container.resolve(Modules.USER).createUsers({ email })
      const auth = container.resolve(Modules.AUTH)
      const { authIdentity, error } = await auth.register('emailpass', { body: { email, password } })
      expect(error).toBeUndefined()
      await auth.updateAuthIdentities({ id: authIdentity!.id, app_metadata: { user_id: user.id } })
      return { user, email, password }
    }
    function command<P>(type: string, payload: P) {
      return { id: randomUUID(), type, version: 3, payload, createdAt: openedAt, deviceId: 'test-approval-close', attempt: 1 }
    }
    function open(registerId: string = randomUUID()) {
      return command('register.session.open', { sessionId: randomUUID(), registerId, openedAt, countedFloatMinor: 100 })
    }
    function close(sessionId: string) {
      return command('register.session.transition', { sessionId, status: 'closed', at: closedAt, counted: { cash: 1601 } })
    }
    function closure(session: RegisterSessionOpenPayload = opening.payload, overrides: Partial<RegisterClosureSubmitV3Payload> = {}) {
      return command<RegisterClosureSubmitV3Payload>('register.closure.submit', {
        closureId: randomUUID(), sessionId: session.sessionId, registerId: session.registerId, number: 1, openedAt, closedAt,
        tillExpected: { cash: 1100 }, counted: { cash: 1601 }, periodSalesTotalMinor: 1000, periodRefundsTotalMinor: 0,
        perpetualSalesTotalMinor: 1000, perpetualRefundsTotalMinor: 0, unsyncedCount: 0, unsyncedTotalMinor: 0,
        softwareVersion: '1.0', orderIds: [], movementIds: [], ...overrides,
      })
    }
    async function post(commands: unknown[]) {
      const response = await api.post('/tally/v1/commands', { commands }, { headers })
      expect(response.status).toBe(200)
      return response.data.results
    }
    async function approve(sessionId = opening.payload.sessionId, variance: Record<string, number> = { cash: 501 }) {
      const response = await api.post('/tally/v1/register-approvals', {
        sessionId, variance, email: manager.email, password: manager.password,
      }, { headers })
      expect(response.status).toBe(200)
      return response.data.approval as string
    }
    function approvalRow(approval: string) {
      return container.resolve(ContainerRegistrationKeys.PG_CONNECTION)('tally_register_approval')
        .where({ token_hash: createHash('sha256').update(approval).digest('hex') })
    }
    beforeEach(async () => {
      container = getContainer()
      const cashier = await makeUser()
      const login = await api.post('/auth/user/emailpass', { email: cashier.email, password: cashier.password })
      expect(login.status).toBe(200)
      headers = { Authorization: `Bearer ${login.data.token}`, 'X-Tally-Protocol': '1' }
      manager = await makeUser()
      opening = open()
      expect((await post([opening, close(opening.payload.sessionId)])).map(result => result.status)).toEqual(['applied', 'applied'])
    })

    it('requires approval for cash variance 501 and returns the payload variance', async () => {
      const closing = closure(opening.payload, { tillExpected: { cash: 1100, external: 20 }, counted: { cash: 1601 } })
      expect((await post([closing]))[0]).toEqual({ id: closing.id, status: 'rejected', error: {
        code: 'register_approval_required', message: 'A manager approval is needed for this variance.',
        data: { sessionId: opening.payload.sessionId, thresholdMinor: 500, variance: { cash: 501 } },
      } })
    })

    it.each([500, -500])('accepts cash variance %s without approval', async variance => {
      const closing = closure(opening.payload, { counted: { cash: 1100 + variance, external: 2000 } })
      expect((await post([closing]))[0]).toMatchObject({ status: 'applied', register: { closure: { approvalVerified: false } } })
    })

    it('verifies the proof, records its manager on the closure and session, and consumes it once', async () => {
      const approval = await approve()
      const closing = closure(opening.payload, { approval, approvedBy: 'someone-else' })
      expect((await post([closing]))[0]).toMatchObject({ status: 'applied', register: { closure: { approvalVerified: true } } })
      const row = await approvalRow(approval).first()
      expect(row.used_at).not.toBeNull()
      expect(row).toMatchObject({ used_by_command_id: closing.id, closure_id: closing.payload.closureId })
      const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
      expect(await knex('tally_register_closure').where({ id: closing.payload.closureId }).first())
        .toMatchObject({ approved_by: manager.user.id, approval_id: row.id })
      expect(await knex('tally_register_session').where({ id: opening.payload.sessionId }).first())
        .toMatchObject({ approved_by: manager.user.id })
    })

    it.each(['unknown', 'used', 'expired', 'session_mismatch', 'variance_mismatch'])('refuses an approval with reason %s', async reason => {
      let approval = 'made-up-proof'
      if (reason === 'used' || reason === 'session_mismatch') {
        const other = open()
        expect((await post([other, close(other.payload.sessionId)])).map(result => result.status)).toEqual(['applied', 'applied'])
        approval = await approve(other.payload.sessionId)
        if (reason === 'used') {
          expect((await post([closure(other.payload, { approval })]))[0].status).toBe('applied')
          await approvalRow(approval).update({ expires_at: '2020-01-01T00:00:00Z' })
        }
      } else if (reason !== 'unknown') {
        approval = await approve(opening.payload.sessionId, { cash: reason === 'variance_mismatch' ? 502 : 501 })
        if (reason === 'expired') await approvalRow(approval).update({ expires_at: '2020-01-01T00:00:00Z' })
      }
      const closing = closure(opening.payload, { approval })
      expect((await post([closing]))[0]).toEqual({ id: closing.id, status: 'rejected', error: {
        code: 'register_approval_invalid', message: 'This manager approval cannot be used.', data: { reason },
      } })
      if (reason !== 'unknown' && reason !== 'used') expect(await approvalRow(approval).first())
        .toMatchObject({ used_at: null, used_by_command_id: null, closure_id: null })
    })

    it('refuses a proof whose variance has an extra key', async () => {
      const approval = await approve(opening.payload.sessionId, { cash: 501, external: 0 })
      expect((await post([closure(opening.payload, { approval })]))[0]).toMatchObject({ status: 'rejected', error: {
        code: 'register_approval_invalid', data: { reason: 'variance_mismatch' },
      } })
    })

    it('refuses an invalid proof even under the threshold', async () => {
      const closing = closure(opening.payload, { approval: 'made-up-proof', counted: { cash: 1100 } })
      expect((await post([closing]))[0]).toMatchObject({ status: 'rejected', error: {
        code: 'register_approval_invalid', data: { reason: 'unknown' },
      } })
    })

    it('uses a valid proof under the threshold, comparing variance without key order', async () => {
      const approval = await approve(opening.payload.sessionId, { external: 2, cash: 0 })
      const closing = closure(opening.payload, { approval, counted: { cash: 1100, external: 2 } })
      expect((await post([closing]))[0]).toMatchObject({ status: 'applied', register: { closure: { approvalVerified: true } } })
      expect(await approvalRow(approval).first()).toMatchObject({ used_by_command_id: closing.id, closure_id: closing.payload.closureId })
      expect((await approvalRow(approval).first()).used_at).not.toBeNull()
    })

    it('stores a refusal and replays it even after the proof expires', async () => {
      const approval = await approve(opening.payload.sessionId, { cash: 502 })
      const closing = closure(opening.payload, { approval })
      const first = await post([closing])
      expect(first[0]).toMatchObject({ status: 'rejected', error: { code: 'register_approval_invalid', data: { reason: 'variance_mismatch' } } })
      await approvalRow(approval).update({ expires_at: '2020-01-01T00:00:00Z' })
      expect(await post([closing])).toEqual(first)
    })

    it('recovers a required-approval refusal on the closed session with a new command and the same closure id', async () => {
      const closing = closure()
      const refused = await post([closing])
      expect(refused[0]).toMatchObject({ status: 'rejected', error: { code: 'register_approval_required' } })
      const approval = await approve()
      const replacement = { ...closing, id: randomUUID(), payload: { ...closing.payload, approval } }
      expect((await post([replacement]))[0]).toMatchObject({ status: 'applied', register: { closure: {
        serverClosureId: closing.payload.closureId, approvalVerified: true,
      } } })
      expect(await post([closing])).toEqual(refused)
    })

    it('replays applied commands and answers an existing closure before checking a used and expired proof', async () => {
      const approval = await approve()
      const closing = closure(opening.payload, { approval })
      const [applied] = await post([closing])
      expect(applied.status).toBe('applied')
      await approvalRow(approval).update({ expires_at: '2020-01-01T00:00:00Z' })
      expect(await post([closing])).toEqual([{ ...applied, status: 'duplicate' }])
      const retry = { ...closing, id: randomUUID() }
      expect(await post([retry])).toEqual([{ ...applied, id: retry.id }])
      expect((await approvalRow(approval).first()).used_by_command_id).toBe(closing.id)
    })

    it('leaves a proof unused after a number refusal, then uses it for the correct number', async () => {
      const approval = await approve()
      const closing = closure(opening.payload, { approval, number: 2 })
      expect((await post([closing]))[0]).toMatchObject({ status: 'rejected', error: { code: 'register_closure_number_invalid' } })
      expect(await approvalRow(approval).first()).toMatchObject({ used_at: null, used_by_command_id: null, closure_id: null })
      const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
      expect(await knex('tally_register_closure').where({ id: closing.payload.closureId })).toHaveLength(0)
      expect((await knex('tally_register_session').where({ id: opening.payload.sessionId }).first()).approved_by).toBeNull()
      const corrected = { ...closing, id: randomUUID(), payload: { ...closing.payload, number: 1 } }
      expect((await post([corrected]))[0]).toMatchObject({ status: 'applied', register: { closure: { approvalVerified: true } } })
      expect(await approvalRow(approval).first()).toMatchObject({ used_by_command_id: corrected.id, closure_id: closing.payload.closureId })
    })

    it('keeps contract 2 over-threshold closes unverified and records approvedBy as sent', async () => {
      const closing = { ...closure(opening.payload, { approvedBy: 'recorded-manager' }), version: 2 }
      const [result] = await post([closing])
      expect(result.status).toBe('applied')
      expect(result.register.closure).not.toHaveProperty('approvalVerified')
      const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
      expect(await knex('tally_register_closure').where({ id: closing.payload.closureId }).first())
        .toMatchObject({ approved_by: 'recorded-manager', approval_id: null })
    })

    it('refuses approval in a contract 2 closure as invalid_payload', async () => {
      const approval = await approve()
      const closing = { ...closure(opening.payload, { approval }), version: 2 }
      expect((await post([closing]))[0]).toMatchObject({ status: 'rejected', error: {
        code: 'invalid_payload', message: 'payload.approval: unknown field for register.closure.submit version 2',
      } })
      expect((await approvalRow(approval).first()).used_at).toBeNull()
    })

    it('uses the canonical session when both the approval and closure name a resumed v2 alias', async () => {
      const canonical = { ...open(), version: 2 }
      const alias = { ...open(canonical.payload.registerId), version: 2 }
      const results = await post([canonical, alias, close(alias.payload.sessionId)])
      expect(results.map(result => result.status)).toEqual(['applied', 'applied', 'applied'])
      expect(results[1].register.resumed).toEqual({ fromSessionId: alias.payload.sessionId })
      const closing = closure(alias.payload)
      expect((await post([closing]))[0]).toMatchObject({ status: 'rejected', error: { code: 'register_approval_required',
        data: { sessionId: alias.payload.sessionId, thresholdMinor: 500, variance: { cash: 501 } },
      } })
      const approval = await approve(alias.payload.sessionId)
      const retry = { ...closing, id: randomUUID(), payload: { ...closing.payload, approval } }
      expect((await post([retry]))[0]).toMatchObject({ status: 'applied', register: { closure: { approvalVerified: true } } })
      const row = await approvalRow(approval).first()
      expect(row).toMatchObject({ session_id: canonical.payload.sessionId, used_by_command_id: retry.id })
      const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
      expect(await knex('tally_register_closure').where({ id: closing.payload.closureId }).first())
        .toMatchObject({ session_id: canonical.payload.sessionId, approval_id: row.id })
    })
  },
})
