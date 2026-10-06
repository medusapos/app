import type { EntityManager } from '@medusajs/framework/mikro-orm/postgresql'
import type { Context } from '@medusajs/framework/types'
import { InjectManager, MedusaContext, MedusaService } from '@medusajs/framework/utils'
import { TallyRegister } from './models/tally-register'
import { TallyRegisterSession } from './models/tally-register-session'
import { TallyRegisterSessionAlias } from './models/tally-register-session-alias'
import { TallyRegisterMovement } from './models/tally-register-movement'
import { TallyRegisterClosure } from './models/tally-register-closure'
import type {
  RegisterCommandResult, RegisterCounters, RegisterOutcome, RegisterSessionOpenInput,
  RegisterSessionTransitionInput, RegisterMovementRecordInput, RegisterMovementVoidInput,
  RegisterClosureSubmitInput, RegisterSessionStatus,
} from './types'

const COUNTERS = `json_build_object('lastClosureNumber', r.last_closure_number,
  'perpetualSalesTotalMinor', r.perpetual_sales_total_minor,
  'perpetualRefundsTotalMinor', r.perpetual_refunds_total_minor)`
const COUNTER_STATE = `select ${COUNTERS} as counters from tally_register r where r.id = ?`
const SESSION_STATE = `select json_build_object('id', s.id, 'status', s.status) as session,
  ${COUNTERS} as counters from tally_register_session s join tally_register r on r.id = s.register_id where s.id = ?`

export default class TallyRegisterModuleService extends MedusaService({
  TallyRegister, TallyRegisterSession, TallyRegisterSessionAlias, TallyRegisterMovement, TallyRegisterClosure,
}) {
  @InjectManager()
  async openSession(p: RegisterSessionOpenInput, @MedusaContext() sharedContext: Context = {}): Promise<RegisterOutcome> {
    return (sharedContext.manager as EntityManager).transactional(async (em): Promise<RegisterOutcome> => {
      const v2 = (p.contract ?? 1) >= 2
      for (let attempt = 0; attempt < 3; attempt++) {
        const [session] = await em.execute('select id, register_id, status from tally_register_session where id = ?', [p.sessionId])
        if (session) {
          if (session.status === 'superseded') return v2
            ? { kind: 'conflict', code: 'register_session_superseded', data: (await this.supersededData(p.sessionId, { manager: em }))! }
            : { kind: 'conflict', code: 'register_session_closed' }
          if (session.register_id !== p.registerId) return { kind: 'invalid', message: 'session id belongs to another register' }
          return { kind: 'ok', register: (await em.execute(SESSION_STATE, [p.sessionId]))[0] }
        }
        const [alias] = v2 ? await em.execute(`select s.* from tally_register_session_alias a
          join tally_register_session s on s.id = a.session_id where a.id = ?`, [p.sessionId]) : []
        if (alias) {
          if (alias.register_id !== p.registerId) return { kind: 'invalid', message: 'session id belongs to another register' }
          if (alias.status === 'superseded') return { kind: 'conflict', code: 'register_session_superseded',
            data: (await this.supersededData(alias.id, { manager: em }))! }
        }
        const [live] = alias ? [alias] : await em.execute(`select * from tally_register_session
          where register_id = ? and status in ('open','counting') and deleted_at is null`, [p.registerId])
        if (!alias && live?.id === p.sessionId) continue
        if (alias || (v2 && live?.device_id != null && live.device_id === p.deviceId)) {
          if (!alias) await em.execute('insert into tally_register_session_alias (id, session_id) values (?, ?) on conflict do nothing', [p.sessionId, live.id])
          const state = (await em.execute(SESSION_STATE, [live.id]))[0]
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
          (id, register_id, store_key, status, business_day, opened_at, opened_by, expected_float_minor, counted_float_minor, opening_variance_minor, device_id, device_name)
          values (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?) on conflict do nothing returning id`,
        [p.sessionId, p.registerId, p.storeKey ?? null, p.businessDay ?? null, p.openedAt, p.openedBy ?? null,
          p.expectedFloatMinor ?? null, p.countedFloatMinor, p.openingVarianceMinor ?? null, p.deviceId ?? null, p.deviceName?.trim() ?? null])
        if (inserted.length) return { kind: 'ok', register: { ...(await em.execute(SESSION_STATE, [p.sessionId]))[0], ...(superseded ? { superseded } : {}) } }
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

  private async lockSession(sessionId: string, em: EntityManager) {
    const [session] = await em.execute(`select id, register_id, status from tally_register_session where id = coalesce(
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
      if (session.status === p.status) return { kind: 'ok', register: (await em.execute(SESSION_STATE, [p.sessionId]))[0] }
      if (session.status === 'superseded') return (p.contract ?? 1) >= 2
        ? { kind: 'conflict', code: 'register_session_superseded', data: (await this.supersededData(p.sessionId, { manager: em }))! }
        : { kind: 'conflict', code: 'register_session_closed' }
      if (session.status === 'closed') return { kind: 'conflict', code: 'register_session_closed' }
      if (p.status === 'closed') {
        await em.execute(`update tally_register_session set status = ?, status_at = ?, closed_at = ?, counted = ?::jsonb,
          closed_by = ?, approved_by = ?, updated_at = now() where id = ?`,
        [p.status, p.at, p.at, p.counted === undefined ? null : JSON.stringify(p.counted), p.closedBy ?? null, p.approvedBy ?? null, p.sessionId])
      } else {
        await em.execute('update tally_register_session set status = ?, status_at = ?, updated_at = now() where id = ?', [p.status, p.at, p.sessionId])
      }
      return { kind: 'ok', register: (await em.execute(SESSION_STATE, [p.sessionId]))[0] }
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
        return { kind: 'ok', register: (await em.execute(SESSION_STATE, [p.sessionId]))[0] }
      }
      if (session.status === 'superseded') return (p.contract ?? 1) >= 2
        ? { kind: 'conflict', code: 'register_session_superseded', data: (await this.supersededData(p.sessionId, { manager: em }))! }
        : { kind: 'conflict', code: 'register_session_closed' }
      const [closure] = await em.execute('select id from tally_register_closure where session_id = ?', [p.sessionId])
      if (session.status === 'closed' || closure) return { kind: 'conflict', code: 'register_session_closed' }
      const inserted = await em.execute(`insert into tally_register_movement
        (id, session_id, type, amount_minor, reason, created_at_client, created_by) values (?, ?, ?, ?, ?, ?, ?)
        on conflict do nothing returning id`, [p.movementId, p.sessionId, p.type, p.amountMinor, p.reason, p.createdAt, p.createdBy ?? null])
      if (!inserted.length) return { kind: 'invalid', message: 'movement id belongs to another session' }
      return { kind: 'ok', register: (await em.execute(SESSION_STATE, [p.sessionId]))[0] }
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
        return { kind: 'ok', register: (await em.execute(SESSION_STATE, [p.sessionId]))[0] }
      }
      if (session.status === 'superseded') return (p.contract ?? 1) >= 2
        ? { kind: 'conflict', code: 'register_session_superseded', data: (await this.supersededData(p.sessionId, { manager: em }))! }
        : { kind: 'conflict', code: 'register_session_closed' }
      const [closure] = await em.execute('select id from tally_register_closure where session_id = ?', [p.sessionId])
      if (session.status === 'closed' || closure) return { kind: 'conflict', code: 'register_session_closed' }
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
      return { kind: 'ok', register: (await em.execute(SESSION_STATE, [p.sessionId]))[0] }
    })
  }

  @InjectManager()
  async submitClosure(p: RegisterClosureSubmitInput, @MedusaContext() sharedContext: Context = {}): Promise<RegisterOutcome> {
    return (sharedContext.manager as EntityManager).transactional(async (em): Promise<RegisterOutcome> => {
      const session = await this.lockSession(p.sessionId, em)
      if (!session) return { kind: 'invalid', message: 'unknown session' }
      p = { ...p, sessionId: session.id }
      let [closure] = await em.execute(`select id, register_id, number from tally_register_closure
        where id = ? or session_id = ? order by (id = ?) desc`, [p.closureId, p.sessionId, p.closureId])
      if (closure?.id !== p.closureId) {
        if (p.registerId !== session.register_id) return { kind: 'invalid', message: "closure registerId does not match the session's register" }
        if (session.status === 'superseded') return (p.contract ?? 1) >= 2
          ? { kind: 'conflict', code: 'register_session_superseded', data: (await this.supersededData(p.sessionId, { manager: em }))! }
          : { kind: 'conflict', code: 'register_session_closed' }
        if (closure) return { kind: 'conflict', code: 'register_closure_exists', data: { closureId: closure.id } }
        let [{ counters }] = await em.execute(`${COUNTER_STATE} for update`, [p.registerId])
        const inserted = p.number === counters.lastClosureNumber + 1
          ? await em.execute(`insert into tally_register_closure
            (id, session_id, register_id, number, business_day, opened_at, closed_at, closed_by, approved_by,
             till_expected, counted, period_sales_total_minor, period_refunds_total_minor, perpetual_sales_total_minor,
             perpetual_refunds_total_minor, unsynced_count, unsynced_total_minor, software_version, order_ids, movement_ids)
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb)
            on conflict do nothing returning id`,
          [p.closureId, p.sessionId, p.registerId, p.number, p.businessDay ?? null, p.openedAt, p.closedAt, p.closedBy ?? null,
            p.approvedBy ?? null, JSON.stringify(p.tillExpected), JSON.stringify(p.counted), p.periodSalesTotalMinor,
            p.periodRefundsTotalMinor, p.perpetualSalesTotalMinor, p.perpetualRefundsTotalMinor, p.unsyncedCount,
            p.unsyncedTotalMinor, p.softwareVersion, JSON.stringify(p.orderIds), JSON.stringify(p.movementIds)]) : []
        if (inserted.length) {
          await em.execute(`update tally_register set last_closure_number = ?,
            perpetual_sales_total_minor = greatest(perpetual_sales_total_minor, ?),
            perpetual_refunds_total_minor = greatest(perpetual_refunds_total_minor, ?), updated_at = now() where id = ?`,
          [p.number, p.perpetualSalesTotalMinor, p.perpetualRefundsTotalMinor, p.registerId])
        }
        ;[closure] = await em.execute(`select id, register_id, number from tally_register_closure
          where id = ? or session_id = ? order by (id = ?) desc`, [p.closureId, p.sessionId, p.closureId])
        if (closure?.id !== p.closureId) {
          if (closure) return { kind: 'conflict', code: 'register_closure_exists', data: { closureId: closure.id } }
          ;[{ counters }] = await em.execute(COUNTER_STATE, [p.registerId])
          return { kind: 'conflict', code: 'register_closure_number_invalid', data: { counters } }
        }
      }
      const [{ counters }] = await em.execute(COUNTER_STATE, [closure.register_id])
      return { kind: 'ok', register: { counters, closure: { serverClosureId: closure.id, number: closure.number } } }
    })
  }

  @InjectManager()
  async figuresInput(sessionId: string, @MedusaContext() sharedContext: Context = {}): Promise<{
    countedFloatMinor: number
    movements: { id: string; type: 'paid_in' | 'paid_out' | 'no_sale' | 'void'; amountMinor: number; voids: string | null }[]
    closure: { orderIds: string[]; movementIds: string[]; counted: Record<string, number> } | null
  } | null> {
    return (sharedContext.manager as EntityManager).transactional(async (em) => {
      const [session] = await em.execute(`select json_build_object('countedFloatMinor', counted_float_minor) as input
        from tally_register_session where id = ?`, [sessionId])
      if (!session) return null
      const movements = await em.execute(`select json_build_object('id', id, 'type', type,
        'amountMinor', amount_minor, 'voids', voids) as movement from tally_register_movement where session_id = ?`, [sessionId])
      const [closure] = await em.execute(`select json_build_object('orderIds', order_ids, 'movementIds', movement_ids,
        'counted', counted) as closure from tally_register_closure where session_id = ?`, [sessionId])
      return { ...session.input, movements: movements.map(row => row.movement), closure: closure?.closure ?? null }
    })
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
}
