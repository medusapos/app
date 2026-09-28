import type { EntityManager } from '@medusajs/framework/mikro-orm/postgresql'
import type { Context } from '@medusajs/framework/types'
import { InjectManager, MedusaContext, MedusaService } from '@medusajs/framework/utils'
import { TallyRegister } from './models/tally-register'
import { TallyRegisterSession } from './models/tally-register-session'
import { TallyRegisterMovement } from './models/tally-register-movement'
import { TallyRegisterClosure } from './models/tally-register-closure'
import type {
  RegisterCommandResult, RegisterCounters, RegisterOutcome, RegisterSessionOpenPayload,
  RegisterSessionTransitionPayload, RegisterMovementRecordPayload, RegisterMovementVoidPayload,
  RegisterClosureSubmitPayload,
} from './types'

const COUNTERS = `json_build_object('lastClosureNumber', r.last_closure_number,
  'perpetualSalesTotalMinor', r.perpetual_sales_total_minor,
  'perpetualRefundsTotalMinor', r.perpetual_refunds_total_minor)`
const COUNTER_STATE = `select ${COUNTERS} as counters from tally_register r where r.id = ?`
const SESSION_STATE = `select json_build_object('id', s.id, 'status', s.status) as session,
  ${COUNTERS} as counters from tally_register_session s join tally_register r on r.id = s.register_id where s.id = ?`

export default class TallyRegisterModuleService extends MedusaService({
  TallyRegister, TallyRegisterSession, TallyRegisterMovement, TallyRegisterClosure,
}) {
  @InjectManager()
  async openSession(p: RegisterSessionOpenPayload, @MedusaContext() sharedContext: Context = {}): Promise<RegisterOutcome> {
    return (sharedContext.manager as EntityManager).transactional(async (em): Promise<RegisterOutcome> => {
      let [session] = await em.execute('select id, register_id from tally_register_session where id = ?', [p.sessionId])
      if (!session) {
        await em.execute('insert into tally_register (id) values (?) on conflict do nothing', [p.registerId])
        for (let attempt = 0; attempt < 3; attempt++) {
          const inserted = await em.execute(`insert into tally_register_session
            (id, register_id, store_key, status, business_day, opened_at, opened_by, expected_float_minor, counted_float_minor, opening_variance_minor)
            values (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?) on conflict do nothing returning id`,
          [p.sessionId, p.registerId, p.storeKey ?? null, p.businessDay ?? null, p.openedAt, p.openedBy ?? null,
            p.expectedFloatMinor ?? null, p.countedFloatMinor, p.openingVarianceMinor ?? null])
          if (inserted.length) return { kind: 'ok', register: (await em.execute(SESSION_STATE, [p.sessionId]))[0] }
          ;[session] = await em.execute('select id, register_id from tally_register_session where id = ?', [p.sessionId])
          if (session) break
          const [active] = await em.execute(`select id from tally_register_session
            where register_id = ? and status <> 'closed' and deleted_at is null`, [p.registerId])
          if (active) return { kind: 'conflict', code: 'register_session_already_open', data: { sessionId: active.id } }
        }
      }
      if (session) {
        if (session.register_id !== p.registerId) return { kind: 'invalid', message: 'session id belongs to another register' }
        return { kind: 'ok', register: (await em.execute(SESSION_STATE, [p.sessionId]))[0] }
      }
      return { kind: 'invalid', message: 'conflicting session is no longer active' }
    })
  }

  @InjectManager()
  async transition(p: RegisterSessionTransitionPayload, @MedusaContext() sharedContext: Context = {}): Promise<RegisterOutcome> {
    return (sharedContext.manager as EntityManager).transactional(async (em): Promise<RegisterOutcome> => {
      const [session] = await em.execute('select id, status from tally_register_session where id = ? for update', [p.sessionId])
      if (!session) return { kind: 'invalid', message: 'unknown session' }
      if (session.status === p.status) return { kind: 'ok', register: (await em.execute(SESSION_STATE, [p.sessionId]))[0] }
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
  async recordMovement(p: RegisterMovementRecordPayload, @MedusaContext() sharedContext: Context = {}): Promise<RegisterOutcome> {
    return (sharedContext.manager as EntityManager).transactional(async (em): Promise<RegisterOutcome> => {
      const [session] = await em.execute('select id, status from tally_register_session where id = ? for update', [p.sessionId])
      if (!session) return { kind: 'invalid', message: 'unknown session' }
      const [existing] = await em.execute('select session_id from tally_register_movement where id = ?', [p.movementId])
      if (existing) {
        if (existing.session_id !== p.sessionId) return { kind: 'invalid', message: 'movement id belongs to another session' }
        return { kind: 'ok', register: (await em.execute(SESSION_STATE, [p.sessionId]))[0] }
      }
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
  async voidMovement(p: RegisterMovementVoidPayload, @MedusaContext() sharedContext: Context = {}): Promise<RegisterOutcome> {
    return (sharedContext.manager as EntityManager).transactional(async (em): Promise<RegisterOutcome> => {
      const [session] = await em.execute('select id, status from tally_register_session where id = ? for update', [p.sessionId])
      if (!session) return { kind: 'invalid', message: 'unknown session' }
      const [existing] = await em.execute('select session_id, type, voids from tally_register_movement where id = ?', [p.movementId])
      if (existing) {
        if (existing.session_id !== p.sessionId || existing.type !== 'void' || existing.voids !== p.voids) {
          return { kind: 'invalid', message: 'movement id does not match this void' }
        }
        return { kind: 'ok', register: (await em.execute(SESSION_STATE, [p.sessionId]))[0] }
      }
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
  async submitClosure(p: RegisterClosureSubmitPayload, @MedusaContext() sharedContext: Context = {}): Promise<RegisterOutcome> {
    return (sharedContext.manager as EntityManager).transactional(async (em): Promise<RegisterOutcome> => {
      const [session] = await em.execute('select register_id from tally_register_session where id = ? for update', [p.sessionId])
      if (!session) return { kind: 'invalid', message: 'unknown session' }
      let [closure] = await em.execute(`select id, register_id, number from tally_register_closure
        where id = ? or session_id = ? order by (id = ?) desc`, [p.closureId, p.sessionId, p.closureId])
      if (closure?.id !== p.closureId) {
        if (p.registerId !== session.register_id) return { kind: 'invalid', message: "closure registerId does not match the session's register" }
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
  async registerState(registerId: string, @MedusaContext() sharedContext: Context = {}): Promise<{
    session?: RegisterCommandResult['session']; counters?: RegisterCounters
  } | null> {
    return (sharedContext.manager as EntityManager).transactional(async (em) => {
      const [register] = await em.execute(COUNTER_STATE, [registerId])
      if (!register) return null
      const [session] = await em.execute<{ id: string; status: 'open' | 'counting' | 'closed' }[]>(`select id, status from tally_register_session where register_id = ? and deleted_at is null
        order by (status <> 'closed') desc, opened_at desc limit 1`, [registerId])
      return { ...register, ...(session ? { session } : {}) }
    })
  }
}
