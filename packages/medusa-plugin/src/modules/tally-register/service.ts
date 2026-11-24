import { createHash, randomUUID } from 'node:crypto'
import type { EntityManager } from '@medusajs/framework/mikro-orm/postgresql'
import type { Context } from '@medusajs/framework/types'
import { InjectManager, MedusaContext, MedusaService } from '@medusajs/framework/utils'
import { TallyRegister } from './models/tally-register'
import { TallyRegisterSession } from './models/tally-register-session'
import { TallyRegisterSessionAlias } from './models/tally-register-session-alias'
import { TallyRegisterMovement } from './models/tally-register-movement'
import { TallyRegisterClosure } from './models/tally-register-closure'
import { TallyRegisterApproval } from './models/tally-register-approval'
import { sessionTakesMoney } from './session-open'
import type {
  RegisterCommandResult, RegisterCounters, RegisterOutcome, RegisterSessionOpenInput,
  RegisterSessionTransitionInput, RegisterMovementRecordInput, RegisterMovementVoidInput,
  RegisterClosureSubmitInput, RegisterSessionStatus, AdmitApprovalResult, IssueApprovalResult, StoredClosure,
} from './types'

// A proof lives for 15 minutes (ADR 0023).
export const APPROVAL_TTL_MS = 15 * 60 * 1000
// Failed and pending approvals count for 15 minutes.
export const APPROVAL_FAILURE_WINDOW_MS = 15 * 60 * 1000
// A requesting cashier may fail five checks per window.
export const MAX_APPROVAL_FAILURES_PER_ACTOR = 5
// A target email may receive ten failed checks per window.
export const MAX_APPROVAL_FAILURES_PER_EMAIL = 10

const COUNTERS = `json_build_object('lastClosureNumber', r.last_closure_number,
  'perpetualSalesTotalMinor', r.perpetual_sales_total_minor,
  'perpetualRefundsTotalMinor', r.perpetual_refunds_total_minor)`
const COUNTER_STATE = `select ${COUNTERS} as counters from tally_register r where r.id = ?`
const SESSION_STATE = `select json_build_object('id', s.id, 'status', s.status) as session,
  ${COUNTERS} as counters from tally_register_session s join tally_register r on r.id = s.register_id where s.id = ?`

export default class TallyRegisterModuleService extends MedusaService({
  TallyRegister, TallyRegisterSession, TallyRegisterSessionAlias, TallyRegisterMovement, TallyRegisterClosure,
  TallyRegisterApproval,
}) {
  // Assumes READ COMMITTED: the failure counts are read after the advisory locks are taken, so each statement sees
  // the rows a writer committed while this one waited on the locks.
  @InjectManager()
  async admitApproval(p: { sessionId: string; variance: Record<string, number>; requestedBy: string; email: string;
    otherFailures?: () => { actor: number; email: number } }, @MedusaContext() sharedContext: Context = {}): Promise<AdmitApprovalResult> {
    return (sharedContext.manager as EntityManager).transactional(async (em): Promise<AdmitApprovalResult> => {
      const session = await this.lockSession(p.sessionId, em)
      if (!session) return { kind: 'refused', code: 'approval_session_unknown' }
      if (session.status === 'superseded' || (await em.execute(
        'select id from tally_register_closure where session_id = ?', [session.id])).length)
        return { kind: 'refused', code: 'approval_session_closed' }
      const email = await this.lockApprovalBudget(p.requestedBy, p.email, em)
      const stored = await this.storedFailureCounts(p.requestedBy, email, em)
      const other = p.otherFailures?.() ?? { actor: 0, email: 0 }
      if (stored.actor + other.actor >= MAX_APPROVAL_FAILURES_PER_ACTOR
        || stored.email + other.email >= MAX_APPROVAL_FAILURES_PER_EMAIL)
        return { kind: 'refused', code: 'approval_rate_limited' }
      const id = `apv_${randomUUID()}`
      await em.execute(`insert into tally_register_approval (id, session_id, variance, requested_by, target_email)
        values (?, ?, ?::jsonb, ?, ?)`, [id, session.id, JSON.stringify(p.variance), p.requestedBy, email])
      return { kind: 'admitted', id }
    })
  }

  // Device-clear approvals decide, against the stored register-approval failures, under admitApproval's locks (ADR 0023).
  // Assumes READ COMMITTED, as admitApproval does: the counts are read after the advisory locks are taken.
  @InjectManager()
  async withApprovalBudget<T>(requestedBy: string, email: string, decide: (stored: { actor: number; email: number }) => T,
    @MedusaContext() sharedContext: Context = {}): Promise<T> {
    return (sharedContext.manager as EntityManager).transactional(async em =>
      decide(await this.storedFailureCounts(requestedBy, await this.lockApprovalBudget(requestedBy, email, em), em)))
  }

  private async lockApprovalBudget(requestedBy: string, rawEmail: string, em: EntityManager): Promise<string> {
    const email = rawEmail.trim().toLowerCase()
    await em.execute('select pg_advisory_xact_lock(hashtextextended(?, 0))', [`tally_approval_actor:${requestedBy}`])
    await em.execute('select pg_advisory_xact_lock(hashtextextended(?, 0))', [`tally_approval_email:${email}`])
    return email
  }

  private async storedFailureCounts(requestedBy: string, email: string, em: EntityManager) {
    const [actor] = await em.execute(`select count(*) as count from tally_register_approval
      where requested_by = ? and token_hash is null and created_at > now() - (? * interval '1 millisecond')`,
    [requestedBy, APPROVAL_FAILURE_WINDOW_MS])
    const [target] = await em.execute(`select count(*) as count from tally_register_approval
      where target_email = ? and token_hash is null and created_at > now() - (? * interval '1 millisecond')`,
    [email, APPROVAL_FAILURE_WINDOW_MS])
    return { actor: Number(actor.count), email: Number(target.count) }
  }

  @InjectManager()
  async issueApproval(id: string, p: { tokenHash: string; approvedBy: string; approvedByName: string },
    @MedusaContext() sharedContext: Context = {}): Promise<IssueApprovalResult> {
    return (sharedContext.manager as EntityManager).transactional(async em => {
      const [row] = await em.execute(`update tally_register_approval set token_hash = ?, approved_by = ?, approved_by_name = ?,
        expires_at = now() + (? * interval '1 millisecond'), updated_at = now() where id = ? returning expires_at`,
      [p.tokenHash, p.approvedBy, p.approvedByName, APPROVAL_TTL_MS, id])
      return { expiresAt: new Date(row.expires_at).toISOString() }
    })
  }

  @InjectManager()
  async openSession(p: RegisterSessionOpenInput, @MedusaContext() sharedContext: Context = {}): Promise<RegisterOutcome> {
    return (sharedContext.manager as EntityManager).transactional(async (em): Promise<RegisterOutcome> => {
      const v2 = (p.contract ?? 1) >= 2
      for (let attempt = 0; attempt < 3; attempt++) {
        const [session] = await em.execute('select id, register_id, status, open_contract from tally_register_session where id = ?', [p.sessionId])
        if (session) {
          if (session.status === 'superseded') return this.supersededOutcome(session, em)
          if (session.register_id !== p.registerId) return { kind: 'invalid', message: 'session id belongs to another register' }
          return { kind: 'ok', register: await this.sessionState(p.sessionId, em) }
        }
        const [alias] = v2 ? await em.execute(`select s.* from tally_register_session_alias a
          join tally_register_session s on s.id = a.session_id where a.id = ?`, [p.sessionId]) : []
        if (alias) {
          if (alias.register_id !== p.registerId) return { kind: 'invalid', message: 'session id belongs to another register' }
          if (alias.status === 'superseded') return { kind: 'conflict', code: 'register_session_superseded',
            data: (await this.supersededData(alias.id, { manager: em }))! }
        }
        let [live]: any[] = alias ? [alias] : await em.execute(`select * from tally_register_session
          where register_id = ? and status in ('open','counting') and deleted_at is null`, [p.registerId])
        if (!alias && live?.id === p.sessionId) continue
        // A live session with a stored closure is finished: close it from its closure and open fresh, never a take-over.
        if (!alias && live && (await this.lockSession(live.id, em)) && (await em.execute(
          'select id from tally_register_closure where session_id = ?', [live.id])).length) {
          const closed = await em.execute(`update tally_register_session s set status = 'closed', status_at = c.closed_at,
            closed_at = c.closed_at, counted = c.counted, closed_by = c.closed_by, approved_by = c.approved_by, updated_at = now()
            from tally_register_closure c where c.session_id = s.id and s.id = ? and s.status in ('open','counting') returning s.id`, [live.id])
          if (!closed.length) continue
          live = undefined
        }
        if (alias || (v2 && live?.device_id != null && live.device_id === p.deviceId)) {
          if (!alias) await em.execute('insert into tally_register_session_alias (id, session_id) values (?, ?) on conflict do nothing', [p.sessionId, live.id])
          const state = await this.sessionState(live.id, em)
          return { kind: 'ok', register: { ...state, session: { ...state.session, openedAt: live.opened_at,
            openingFloatMinor: Number(live.counted_float_minor) }, resumed: { fromSessionId: p.sessionId } } }
        }
        let superseded: RegisterCommandResult['superseded']
        if (live) {
          if (!v2) return { kind: 'conflict', code: 'register_session_already_open', data: { sessionId: live.id } }
          const device = { ...(live.device_id == null ? {} : { deviceId: live.device_id }),
            ...(live.device_name == null ? {} : { deviceName: live.device_name }) }
          if (p.supersedes !== live.id) return { kind: 'conflict', code: 'register_session_already_open', data: {
            sessionId: live.id, registerId: live.register_id, openedAt: live.opened_at, status: live.status,
            ...(live.opened_by == null ? {} : { openedBy: live.opened_by }), ...device } }
          const changed = await em.execute(`update tally_register_session set status = 'superseded', superseded_at = ?,
            superseded_by = ?, superseded_by_device = ?, superseded_by_session = ?, status_at = ?, updated_at = now()
            where id = ? and status in ('open','counting') returning id`,
          [p.openedAt, p.openedBy ?? null, p.deviceId ?? null, p.sessionId, p.openedAt, live.id])
          if (!changed.length) continue
          superseded = { sessionId: live.id, openedAt: live.opened_at, ...device }
        }
        await em.execute('insert into tally_register (id) values (?) on conflict do nothing', [p.registerId])
        const inserted = await em.execute(`insert into tally_register_session
          (id, register_id, store_key, status, business_day, opened_at, opened_by, expected_float_minor, counted_float_minor, opening_variance_minor, device_id, device_name, open_contract)
          values (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict do nothing returning id`,
        [p.sessionId, p.registerId, p.storeKey ?? null, p.businessDay ?? null, p.openedAt, p.openedBy ?? null,
          p.expectedFloatMinor ?? null, p.countedFloatMinor, p.openingVarianceMinor ?? null, p.deviceId ?? null, p.deviceName?.trim() ?? null, p.contract ?? 1])
        if (inserted.length) return { kind: 'ok', register: { ...(await this.sessionState(p.sessionId, em)), ...(superseded ? { superseded } : {}) } }
      }
      return { kind: 'invalid', message: 'conflicting session is no longer active' }
    })
  }

  @InjectManager()
  async supersededData(sessionId: string, @MedusaContext() sharedContext: Context = {}): Promise<Record<string, unknown> | null> {
    const [row] = await (sharedContext.manager as EntityManager).execute(`select json_strip_nulls(json_build_object(
      'sessionId', s.id, 'supersededAt', s.superseded_at, 'newSessionId', s.superseded_by_session,
      'supersededBy', s.superseded_by, 'deviceId', s.superseded_by_device, 'deviceName', taker.device_name)) as data
      from tally_register_session s left join tally_register_session taker on taker.id = s.superseded_by_session
      where s.id = ? and s.status = 'superseded'`, [sessionId])
    return row?.data ?? null
  }

  // session is a raw tally_register_session row. A taken-over session answers superseded whatever contract it opened at (ADR-078 d4, TallyUI #515).
  private async supersededOutcome(session: Record<string, any>, em: EntityManager): Promise<RegisterOutcome> {
    return { kind: 'conflict', code: 'register_session_superseded', data: (await this.supersededData(session.id, { manager: em }))! }
  }

  private async sessionState(sessionId: string, em: EntityManager) {
    return (await em.execute(SESSION_STATE, [sessionId]))[0]
  }

  private async lockSession(sessionId: string, em: EntityManager) {
    const [session] = await em.execute(`select id, register_id, status, open_contract from tally_register_session where id = coalesce(
      (select id from tally_register_session where id = ?),
      (select session_id from tally_register_session_alias where id = ?)) for update`, [sessionId, sessionId])
    return session
  }

  @InjectManager()
  async transition(p: RegisterSessionTransitionInput, @MedusaContext() sharedContext: Context = {}): Promise<RegisterOutcome> {
    return (sharedContext.manager as EntityManager).transactional(async (em): Promise<RegisterOutcome> => {
      const session = await this.lockSession(p.sessionId, em)
      if (!session) return { kind: 'invalid', message: 'unknown session' }
      p = { ...p, sessionId: session.id }
      if (session.status === p.status) return { kind: 'ok', register: await this.sessionState(p.sessionId, em) }
      if (session.status === 'superseded') return this.supersededOutcome(session, em)
      if (session.status === 'closed') return { kind: 'conflict', code: 'register_session_closed' }
      if (p.status === 'closed') {
        await em.execute(`update tally_register_session set status = ?, status_at = ?, closed_at = ?, counted = ?::jsonb,
          closed_by = ?, approved_by = ?, updated_at = now() where id = ?`,
        [p.status, p.at, p.at, p.counted === undefined ? null : JSON.stringify(p.counted), p.closedBy ?? null, p.approvedBy ?? null, p.sessionId])
      } else {
        await em.execute('update tally_register_session set status = ?, status_at = ?, updated_at = now() where id = ?', [p.status, p.at, p.sessionId])
      }
      return { kind: 'ok', register: await this.sessionState(p.sessionId, em) }
    })
  }

  @InjectManager()
  async recordMovement(p: RegisterMovementRecordInput, @MedusaContext() sharedContext: Context = {}): Promise<RegisterOutcome> {
    return (sharedContext.manager as EntityManager).transactional(async (em): Promise<RegisterOutcome> => {
      const session = await this.lockSession(p.sessionId, em)
      if (!session) return { kind: 'invalid', message: 'unknown session' }
      p = { ...p, sessionId: session.id }
      const [existing] = await em.execute('select session_id from tally_register_movement where id = ?', [p.movementId])
      if (existing) {
        if (existing.session_id !== p.sessionId) return { kind: 'invalid', message: 'movement id belongs to another session' }
        return { kind: 'ok', register: await this.sessionState(p.sessionId, em) }
      }
      if (session.status === 'superseded') return this.supersededOutcome(session, em)
      if (!await sessionTakesMoney(session, (sql, params) => em.execute(sql, params))) return { kind: 'conflict', code: 'register_session_closed' }
      const inserted = await em.execute(`insert into tally_register_movement
        (id, session_id, type, amount_minor, reason, created_at_client, created_by) values (?, ?, ?, ?, ?, ?, ?)
        on conflict do nothing returning id`, [p.movementId, p.sessionId, p.type, p.amountMinor, p.reason, p.createdAt, p.createdBy ?? null])
      if (!inserted.length) return { kind: 'invalid', message: 'movement id belongs to another session' }
      return { kind: 'ok', register: await this.sessionState(p.sessionId, em) }
    })
  }

  @InjectManager()
  async voidMovement(p: RegisterMovementVoidInput, @MedusaContext() sharedContext: Context = {}): Promise<RegisterOutcome> {
    return (sharedContext.manager as EntityManager).transactional(async (em): Promise<RegisterOutcome> => {
      const session = await this.lockSession(p.sessionId, em)
      if (!session) return { kind: 'invalid', message: 'unknown session' }
      p = { ...p, sessionId: session.id }
      const [existing] = await em.execute('select session_id, type, voids from tally_register_movement where id = ?', [p.movementId])
      if (existing) {
        if (existing.session_id !== p.sessionId || existing.type !== 'void' || existing.voids !== p.voids) {
          return { kind: 'invalid', message: 'movement id does not match this void' }
        }
        return { kind: 'ok', register: await this.sessionState(p.sessionId, em) }
      }
      if (session.status === 'superseded') return this.supersededOutcome(session, em)
      if (!await sessionTakesMoney(session, (sql, params) => em.execute(sql, params))) return { kind: 'conflict', code: 'register_session_closed' }
      const [target] = await em.execute('select session_id, type, voided_by from tally_register_movement where id = ?', [p.voids])
      if (!target) return { kind: 'invalid', message: 'void target is missing' }
      if (target.session_id !== p.sessionId) return { kind: 'invalid', message: 'void target belongs to another session' }
      if (target.type === 'void') return { kind: 'invalid', message: 'void target is a void row' }
      if (target.voided_by !== null) return { kind: 'invalid', message: 'void target is already voided' }
      const inserted = await em.execute(`insert into tally_register_movement
        (id, session_id, type, amount_minor, reason, created_at_client, created_by, voids)
        values (?, ?, 'void', 0, null, ?, ?, ?) on conflict do nothing returning id`,
      [p.movementId, p.sessionId, p.createdAt, p.createdBy ?? null, p.voids])
      if (!inserted.length) {
        const [voided] = await em.execute('select id from tally_register_movement where voids = ? and deleted_at is null', [p.voids])
        return { kind: 'invalid', message: voided ? 'void target is already voided' : 'movement id does not match this void' }
      }
      await em.execute('update tally_register_movement set voided_by = ?, updated_at = now() where id = ?', [p.movementId, p.voids])
      return { kind: 'ok', register: await this.sessionState(p.sessionId, em) }
    })
  }

  @InjectManager()
  async submitClosure(p: RegisterClosureSubmitInput, @MedusaContext() sharedContext: Context = {}): Promise<RegisterOutcome> {
    return (sharedContext.manager as EntityManager).transactional(async (em): Promise<RegisterOutcome> => {
      const sentSessionId = p.sessionId
      const v3 = (p.contract ?? 1) >= 3
      const session = await this.lockSession(p.sessionId, em)
      if (!session) return { kind: 'invalid', message: 'unknown session' }
      p = { ...p, sessionId: session.id }
      let [closure] = await em.execute(`select id, register_id, number, approval_id from tally_register_closure
        where id = ? or session_id = ? order by (id = ?) desc`, [p.closureId, p.sessionId, p.closureId])
      if (closure?.id !== p.closureId) {
        if (p.registerId !== session.register_id) return { kind: 'invalid', message: "closure registerId does not match the session's register" }
        if (session.status === 'superseded') return this.supersededOutcome(session, em)
        if (closure) return { kind: 'conflict', code: 'register_closure_exists', data: { closureId: closure.id } }
        let approval: { id: string; approved_by: string } | undefined
        if (v3) {
          // ADR 0023 amendment (2026-11-22): with every sale synced the server's own expected figures decide; else the till's.
          const expected = (await p.serverExpected?.()) ?? p.tillExpected
          const variance = Object.fromEntries(Object.entries(p.counted).map(([k, v]) => [k, v - (expected[k] ?? 0)]))
          const thresholdMinor = p.thresholdMinor!
          // A counted without cash counts as 0 cash, so leaving it out never skips the gate.
          const over = Math.abs((p.counted.cash ?? 0) - (expected.cash ?? 0)) > thresholdMinor
          if (p.approval === undefined && over) return { kind: 'conflict', code: 'register_approval_required',
            data: { sessionId: sentSessionId, thresholdMinor, variance } }
          if (p.approval !== undefined) {
            const [row] = await em.execute(`select *, expires_at <= now() as expired from tally_register_approval
              where token_hash = ? for update`, [createHash('sha256').update(p.approval).digest('hex')])
            const reason = !row ? 'unknown' : row.used_at ? 'used' : row.expired ? 'expired'
              : row.session_id !== session.id ? 'session_mismatch'
              : Object.keys(row.variance).length !== Object.keys(variance).length
                || Object.entries(variance).some(([k, v]) => row.variance[k] !== v) ? 'variance_mismatch' : undefined
            if (reason) return { kind: 'conflict', code: 'register_approval_invalid', data: { reason, variance } }
            approval = { id: row.id as string, approved_by: row.approved_by as string }
          }
        }
        let [{ counters }] = await em.execute(`${COUNTER_STATE} for update`, [p.registerId])
        const inserted = p.number === counters.lastClosureNumber + 1
          ? await em.execute(`insert into tally_register_closure
            (id, session_id, register_id, number, business_day, opened_at, closed_at, closed_by, approved_by,
             till_expected, counted, period_sales_total_minor, period_refunds_total_minor, perpetual_sales_total_minor,
             perpetual_refunds_total_minor, unsynced_count, unsynced_total_minor, software_version, order_ids, movement_ids, approval_id)
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?)
            on conflict do nothing returning id`,
          [p.closureId, p.sessionId, p.registerId, p.number, p.businessDay ?? null, p.openedAt, p.closedAt, p.closedBy ?? null,
            approval ? approval.approved_by : p.approvedBy ?? null, JSON.stringify(p.tillExpected), JSON.stringify(p.counted), p.periodSalesTotalMinor,
            p.periodRefundsTotalMinor, p.perpetualSalesTotalMinor, p.perpetualRefundsTotalMinor, p.unsyncedCount,
            p.unsyncedTotalMinor, p.softwareVersion, JSON.stringify(p.orderIds), JSON.stringify(p.movementIds), approval?.id ?? null]) : []
        if (inserted.length) {
          await em.execute(`update tally_register set last_closure_number = ?,
            perpetual_sales_total_minor = greatest(perpetual_sales_total_minor, ?),
            perpetual_refunds_total_minor = greatest(perpetual_refunds_total_minor, ?), updated_at = now() where id = ?`,
          [p.number, p.perpetualSalesTotalMinor, p.perpetualRefundsTotalMinor, p.registerId])
          if (approval) {
            await em.execute(`update tally_register_approval set used_at = now(), used_by_command_id = ?, closure_id = ? where id = ?`,
              [p.commandId, p.closureId, approval.id])
            await em.execute('update tally_register_session set approved_by = ?, updated_at = now() where id = ?', [approval.approved_by, session.id])
          }
        }
        ;[closure] = await em.execute(`select id, register_id, number, approval_id from tally_register_closure
          where id = ? or session_id = ? order by (id = ?) desc`, [p.closureId, p.sessionId, p.closureId])
        if (closure?.id !== p.closureId) {
          if (closure) return { kind: 'conflict', code: 'register_closure_exists', data: { closureId: closure.id } }
          ;[{ counters }] = await em.execute(COUNTER_STATE, [p.registerId])
          return { kind: 'conflict', code: 'register_closure_number_invalid', data: { counters } }
        }
      }
      const [{ counters }] = await em.execute(COUNTER_STATE, [closure.register_id])
      return { kind: 'ok', register: { counters, closure: { serverClosureId: closure.id, number: closure.number,
        ...(v3 ? { approvalVerified: closure.approval_id !== null } : {}) } } }
    })
  }

  @InjectManager()
  async figuresInput(sessionId: string, @MedusaContext() sharedContext: Context = {}): Promise<{
    sessionIds: string[]
    countedFloatMinor: number
    movements: { id: string; type: 'paid_in' | 'paid_out' | 'no_sale' | 'void'; amountMinor: number; voids: string | null }[]
    closure: { orderIds: string[]; movementIds: string[]; counted: Record<string, number> } | null
  } | null> {
    return (sharedContext.manager as EntityManager).transactional(async (em) => {
      const [session] = await em.execute(`select id, json_build_object('countedFloatMinor', counted_float_minor,
        'sessionIds', array_prepend(id, array(select id from tally_register_session_alias where session_id = s.id))) as input
        from tally_register_session s where id = coalesce((select id from tally_register_session where id = ?),
          (select session_id from tally_register_session_alias where id = ?))`, [sessionId, sessionId])
      if (!session) return null
      const movements = await em.execute(`select json_build_object('id', id, 'type', type,
        'amountMinor', amount_minor, 'voids', voids) as movement from tally_register_movement where session_id = ?`, [session.id])
      const [closure] = await em.execute(`select json_build_object('orderIds', order_ids, 'movementIds', movement_ids,
        'counted', counted) as closure from tally_register_closure where session_id = ?`, [session.id])
      return { ...session.input, movements: movements.map(row => row.movement), closure: closure?.closure ?? null }
    })
  }

  @InjectManager()
  async isKnownSession(sessionId: string, @MedusaContext() sharedContext: Context = {}): Promise<boolean> {
    const [row] = await (sharedContext.manager as EntityManager).execute(`select exists(
      select id from tally_register_session where id = ? union all select id from tally_register_session_alias where id = ?) as known`, [sessionId, sessionId])
    return row.known
  }

  @InjectManager()
  async registerState(registerId: string, @MedusaContext() sharedContext: Context = {}): Promise<{
    session?: Omit<NonNullable<RegisterCommandResult['session']>, 'status'> & { status: RegisterSessionStatus }; counters?: RegisterCounters
  } | null> {
    return (sharedContext.manager as EntityManager).transactional(async (em) => {
      const [register] = await em.execute(COUNTER_STATE, [registerId])
      if (!register) return null
      const [session] = await em.execute<{ id: string; status: RegisterSessionStatus }[]>(`select id, status from tally_register_session where register_id = ? and deleted_at is null
        order by (status in ('open','counting')) desc, opened_at desc limit 1`, [registerId])
      return { ...register, ...(session ? { session } : {}) }
    })
  }

  @InjectManager()
  async closureHistory(registerId: string, page: { limit: number; before?: number; from?: string; to?: string; cashier?: string },
    @MedusaContext() sharedContext: Context = {}): Promise<{ closures: StoredClosure[]; more: boolean } | null> {
    const em = sharedContext.manager as EntityManager
    const [register] = await em.execute('select id from tally_register where id = ?', [registerId])
    if (!register) return null
    const { limit, before, from, to, cashier } = page
    const clauses = ['c.register_id = ?', 'c.deleted_at is null']
    const bindings: (string | number)[] = [registerId]
    if (before !== undefined) { clauses.push('c.number < ?'); bindings.push(before) }
    if (from !== undefined) { clauses.push('coalesce(c.business_day, substr(c.opened_at, 1, 10)) >= ?'); bindings.push(from) }
    if (to !== undefined) { clauses.push('coalesce(c.business_day, substr(c.opened_at, 1, 10)) <= ?'); bindings.push(to) }
    if (cashier !== undefined) { clauses.push('c.closed_by = ?'); bindings.push(cashier) }
    const rows = await em.execute<{ closure: StoredClosure }[]>(`select json_build_object(
      'id', c.id, 'session_id', c.session_id, 'register_id', c.register_id, 'number', c.number,
      'business_day', c.business_day, 'opened_at', c.opened_at, 'closed_at', c.closed_at,
      'closed_by', c.closed_by, 'approved_by', c.approved_by, 'approval_id', c.approval_id,
      'till_expected', c.till_expected, 'counted', c.counted,
      'period_sales_total_minor', c.period_sales_total_minor, 'period_refunds_total_minor', c.period_refunds_total_minor,
      'perpetual_sales_total_minor', c.perpetual_sales_total_minor, 'perpetual_refunds_total_minor', c.perpetual_refunds_total_minor,
      'unsynced_count', c.unsynced_count, 'unsynced_total_minor', c.unsynced_total_minor, 'software_version', c.software_version,
      'order_ids', c.order_ids, 'movement_ids', c.movement_ids,
      'store_key', s.store_key, 'device_name', s.device_name, 'opened_by', s.opened_by) as closure
      from tally_register_closure c left join tally_register_session s on s.id = c.session_id
      where ${clauses.join(' and ')} order by c.number desc limit ?`, [...bindings, limit + 1])
    return { closures: rows.slice(0, limit).map(r => r.closure), more: rows.length > limit }
  }
}
