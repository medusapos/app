import { randomUUID } from 'node:crypto'
import { moduleIntegrationTestRunner } from '@medusajs/test-utils'
import { TALLY_REGISTER_MODULE } from '..'
import TallyRegisterModuleService from '../service'
import type {
  RegisterClosureSubmitPayload, RegisterMovementRecordPayload, RegisterSessionOpenPayload,
} from '../types'

moduleIntegrationTestRunner<TallyRegisterModuleService>({
  moduleName: TALLY_REGISTER_MODULE,
  resolve: './src/modules/tally-register',
  pathToMigrations: './src/modules/tally-register/migrations',
  testSuite: ({ service, MikroOrmWrapper }) => {
    const first: RegisterSessionOpenPayload = {
      sessionId: randomUUID(), registerId: randomUUID(), storeKey: 'shop', businessDay: '2026-09-28',
      openedAt: '2026-09-28T08:00:00Z', openedBy: 'cashier', expectedFloatMinor: 10000,
      countedFloatMinor: 9900, openingVarianceMinor: -100,
    }
    const second = { ...first, sessionId: randomUUID(), openedAt: '2026-09-28T12:00:00Z' }
    const at = '2026-09-28T11:00:00Z'
    const movement: RegisterMovementRecordPayload = {
      movementId: randomUUID(), sessionId: first.sessionId, type: 'paid_out', amountMinor: -300,
      reason: 'supplies', createdAt: '2026-09-28T09:00:00Z', createdBy: 'cashier',
    }
    const voidPayload = {
      movementId: randomUUID(), sessionId: first.sessionId, voids: movement.movementId,
      createdAt: '2026-09-28T10:00:00Z', createdBy: 'manager',
    }
    const zero = { lastClosureNumber: 0, perpetualSalesTotalMinor: 0, perpetualRefundsTotalMinor: 0 }
    const closure = (overrides: Partial<RegisterClosureSubmitPayload> = {}): RegisterClosureSubmitPayload => ({
      closureId: randomUUID(), sessionId: first.sessionId, registerId: first.registerId, number: 1,
      businessDay: first.businessDay, openedAt: first.openedAt, closedAt: at, closedBy: 'cashier', approvedBy: 'manager',
      tillExpected: { cash: 12000, card: 3000 }, counted: { cash: 11900, card: 3000 },
      periodSalesTotalMinor: 5000, periodRefundsTotalMinor: 100, perpetualSalesTotalMinor: 5000,
      perpetualRefundsTotalMinor: 100, unsyncedCount: 1, unsyncedTotalMinor: 200,
      softwareVersion: '2.0.0', orderIds: ['order-1'], movementIds: [movement.movementId], ...overrides,
    })
    const sql = (query: string, params: unknown[] = []) => MikroOrmWrapper.forkManager().execute(query, params)
    const tables = ['tally_register', 'tally_register_session', 'tally_register_movement', 'tally_register_closure']
    const snapshot = async () => {
      const rows: Record<string, unknown> = {}
      for (const table of tables) rows[table] = await sql(`select * from ${table} order by id`)
      return rows
    }

    it('opens a session and creates the register', async () => {
      expect(await service.openSession(first)).toEqual({
        kind: 'ok', register: { session: { id: first.sessionId, status: 'open' }, counters: zero },
      })
      expect(await sql('select * from tally_register_session')).toEqual([expect.objectContaining({
        id: first.sessionId, register_id: first.registerId, store_key: 'shop', status: 'open',
        business_day: first.businessDay, opened_at: first.openedAt, opened_by: 'cashier',
        expected_float_minor: '10000', counted_float_minor: '9900', opening_variance_minor: '-100',
        status_at: null, closed_at: null, closed_by: null, approved_by: null, counted: null,
        created_at: expect.any(String), updated_at: expect.any(String), deleted_at: null,
      })])
      expect(await sql('select id, last_closure_number, perpetual_refunds_total_minor from tally_register')).toEqual([
        { id: first.registerId, last_closure_number: 0, perpetual_refunds_total_minor: '0' },
      ])
    })

    it('stores omitted opening fields as null', async () => {
      await service.openSession({ sessionId: first.sessionId, registerId: first.registerId, openedAt: first.openedAt, countedFloatMinor: 0 })
      expect(await sql('select * from tally_register_session')).toEqual([expect.objectContaining({
        store_key: null, business_day: null, opened_by: null, expected_float_minor: null,
        counted_float_minor: '0', opening_variance_minor: null,
      })])
    })

    it("refuses a second open session for the register with register_session_already_open and the winner's id", async () => {
      await service.openSession(first)
      const before = await snapshot()
      expect(await service.openSession(second)).toEqual({
        kind: 'conflict', code: 'register_session_already_open', data: { sessionId: first.sessionId },
      })
      expect(await snapshot()).toEqual(before)
      await service.transition({ sessionId: first.sessionId, status: 'counting', at })
      expect(await service.openSession(second)).toEqual({
        kind: 'conflict', code: 'register_session_already_open', data: { sessionId: first.sessionId },
      })
    })

    it('a movement amount and a float above 2^31 are stored', async () => {
      expect(await service.openSession({
        ...first, expectedFloatMinor: 3_000_000_000, countedFloatMinor: 6_000_000_000, openingVarianceMinor: 3_000_000_000,
      })).toMatchObject({ kind: 'ok' })
      expect(await service.recordMovement({ ...movement, type: 'paid_in', amountMinor: 3_000_000_000 })).toMatchObject({ kind: 'ok' })
      expect(await sql('select expected_float_minor, counted_float_minor, opening_variance_minor from tally_register_session')).toEqual([
        { expected_float_minor: '3000000000', counted_float_minor: '6000000000', opening_variance_minor: '3000000000' },
      ])
      expect(await sql('select amount_minor from tally_register_movement')).toEqual([{ amount_minor: '3000000000' }])
    })

    it('allows a new open session after the previous one closed', async () => {
      await service.openSession(first)
      await service.transition({ sessionId: first.sessionId, status: 'closed', at })
      expect(await service.openSession(second)).toEqual({
        kind: 'ok', register: { session: { id: second.sessionId, status: 'open' }, counters: zero },
      })
      expect(await sql('select id from tally_register_session')).toHaveLength(2)
    })

    it('refuses a movement or transition on a closed session with register_session_closed', async () => {
      await service.openSession(first)
      await service.recordMovement(movement)
      await service.transition({ sessionId: first.sessionId, status: 'closed', at })
      const before = await snapshot()
      expect(await service.recordMovement({ ...movement, movementId: randomUUID() })).toEqual({ kind: 'conflict', code: 'register_session_closed' })
      expect(await service.voidMovement(voidPayload)).toEqual({ kind: 'conflict', code: 'register_session_closed' })
      expect(await service.transition({ sessionId: first.sessionId, status: 'open', at })).toEqual({ kind: 'conflict', code: 'register_session_closed' })
      expect(await snapshot()).toEqual(before)
    })

    it('accepts a movement and a void on a counting session', async () => {
      await service.openSession(first)
      await service.transition({ sessionId: first.sessionId, status: 'counting', at })
      const expected = { kind: 'ok', register: { session: { id: first.sessionId, status: 'counting' }, counters: zero } }
      expect(await service.recordMovement(movement)).toEqual(expected)
      expect(await service.voidMovement(voidPayload)).toEqual(expected)
      expect(await sql('select id from tally_register_movement')).toHaveLength(2)
      expect(await sql('select voided_by from tally_register_movement where id = ?', [movement.movementId])).toEqual([{ voided_by: voidPayload.movementId }])
    })

    it("refuses a movement once the session's closure exists, even while the session is still counting", async () => {
      await service.openSession(first)
      await service.recordMovement(movement)
      await service.transition({ sessionId: first.sessionId, status: 'counting', at })
      expect(await service.submitClosure(closure())).toMatchObject({ kind: 'ok' })
      expect(await sql('select status from tally_register_session')).toEqual([{ status: 'counting' }])
      const before = await snapshot()
      expect(await service.recordMovement({ ...movement, movementId: randomUUID() })).toEqual({ kind: 'conflict', code: 'register_session_closed' })
      expect(await service.voidMovement(voidPayload)).toEqual({ kind: 'conflict', code: 'register_session_closed' })
      expect(await snapshot()).toEqual(before)
    })

    it('a transition snapshot is accepted from any non-closed state, and refused only from closed', async () => {
      await service.openSession(first)
      for (const [from, status] of [
        ['open', 'open'], ['open', 'counting'], ['counting', 'counting'], ['counting', 'open'], ['open', 'closed'],
      ] as const) {
        const before = await snapshot()
        expect(await service.transition({ sessionId: first.sessionId, status, at: from === status ? '2026-09-28T12:00:00Z' : at })).toEqual({
          kind: 'ok', register: { session: { id: first.sessionId, status }, counters: zero },
        })
        expect(await sql('select status from tally_register_session')).toEqual([{ status }])
        if (from === status) expect(await snapshot()).toEqual(before)
      }
      const before = await snapshot()
      expect(await service.transition({ sessionId: first.sessionId, status: 'open', at })).toEqual({ kind: 'conflict', code: 'register_session_closed' })
      expect(await snapshot()).toEqual(before)
      await service.openSession(second)
      for (const status of ['counting', 'closed'] as const) {
        expect(await service.transition({ sessionId: second.sessionId, status, at })).toEqual({
          kind: 'ok', register: { session: { id: second.sessionId, status }, counters: zero },
        })
        expect(await sql('select status from tally_register_session where id = ?', [second.sessionId])).toEqual([{ status }])
      }
    })

    it('transitions apply in received order whatever their at: a later-received transition with an earlier at still applies', async () => {
      await service.openSession(first)
      await service.transition({ sessionId: first.sessionId, status: 'counting', at })
      expect(await service.transition({ sessionId: first.sessionId, status: 'open', at: '2026-09-28T10:00:00Z' })).toEqual({
        kind: 'ok', register: { session: { id: first.sessionId, status: 'open' }, counters: zero },
      })
      expect(await sql('select status, status_at from tally_register_session')).toEqual([{ status: 'open', status_at: '2026-09-28T10:00:00Z' }])
    })

    it.each([[at, 'not-a-date'], ['not-a-date', at]])('applies a snapshot when a timestamp cannot parse (%s, %s)', async (storedAt, incomingAt) => {
      await service.openSession(first)
      await service.transition({ sessionId: first.sessionId, status: 'counting', at: storedAt })
      expect(await service.transition({ sessionId: first.sessionId, status: 'open', at: incomingAt })).toMatchObject({
        kind: 'ok', register: { session: { status: 'open' } },
      })
      expect(await sql('select status_at from tally_register_session')).toEqual([{ status_at: incomingAt }])
    })

    it('stores each allowed transition and soft approval as sent', async () => {
      await service.openSession(first)
      for (const status of ['counting', 'open', 'counting'] as const) {
        expect(await service.transition({ sessionId: first.sessionId, status, at })).toEqual({
          kind: 'ok', register: { session: { id: first.sessionId, status }, counters: zero },
        })
      }
      const counted = { cash: 12300, card: 4200 }
      expect(await service.transition({ sessionId: first.sessionId, status: 'closed', at, counted, closedBy: 'cashier', approvedBy: 'unverified' })).toEqual({
        kind: 'ok', register: { session: { id: first.sessionId, status: 'closed' }, counters: zero },
      })
      expect(await sql('select status, status_at, closed_at, closed_by, approved_by, counted from tally_register_session')).toEqual([
        { status: 'closed', status_at: at, closed_at: at, closed_by: 'cashier', approved_by: 'unverified', counted },
      ])
    })

    it('refuses unknown sessions without writing any rows', async () => {
      expect(await service.transition({ sessionId: first.sessionId, status: 'counting', at })).toEqual({ kind: 'invalid', message: 'unknown session' })
      expect(await service.recordMovement(movement)).toEqual({ kind: 'invalid', message: 'unknown session' })
      expect(await service.voidMovement(voidPayload)).toEqual({ kind: 'invalid', message: 'unknown session' })
      expect(await service.submitClosure(closure())).toEqual({ kind: 'invalid', message: 'unknown session' })
      expect(await snapshot()).toEqual(Object.fromEntries(tables.map(table => [table, []])))
    })

    it.each([
      ['paid_in', 700], ['paid_out', -300], ['no_sale', 0],
    ] as const)('stores %s movement values as sent', async (type, amountMinor) => {
      await service.openSession(first)
      expect(await service.recordMovement({ ...movement, type, amountMinor })).toEqual({
        kind: 'ok', register: { session: { id: first.sessionId, status: 'open' }, counters: zero },
      })
      expect(await sql('select * from tally_register_movement')).toEqual([expect.objectContaining({
        id: movement.movementId, session_id: first.sessionId, type, amount_minor: String(amountMinor),
        reason: movement.reason, created_at_client: movement.createdAt, created_by: movement.createdBy,
        voids: null, voided_by: null,
      })])
    })

    it('voids a movement once, in the same session only', async () => {
      await service.openSession(first)
      await service.openSession({ ...second, registerId: randomUUID() })
      await service.recordMovement(movement)
      expect(await service.voidMovement({ ...voidPayload, sessionId: second.sessionId })).toEqual({ kind: 'invalid', message: 'void target belongs to another session' })
      expect(await service.voidMovement({ ...voidPayload, voids: randomUUID() })).toEqual({ kind: 'invalid', message: 'void target is missing' })
      expect(await service.voidMovement(voidPayload)).toEqual({
        kind: 'ok', register: { session: { id: first.sessionId, status: 'open' }, counters: zero },
      })
      const before = await snapshot()
      expect(await service.voidMovement({ ...voidPayload, movementId: randomUUID() })).toEqual({ kind: 'invalid', message: 'void target is already voided' })
      expect(await service.voidMovement({ ...voidPayload, movementId: randomUUID(), voids: voidPayload.movementId })).toEqual({ kind: 'invalid', message: 'void target is a void row' })
      expect(await snapshot()).toEqual(before)
      expect(await sql('select voided_by from tally_register_movement where id = ?', [movement.movementId])).toEqual([{ voided_by: voidPayload.movementId }])
      expect(await sql('select id from tally_register_movement')).toHaveLength(2)
    })

    it('enforces void-once in the database and maps its unique conflict', async () => {
      await service.openSession(first)
      await service.recordMovement(movement)
      const insert = `insert into tally_register_movement (id, session_id, type, amount_minor, created_at_client, voids)
        values (?, ?, 'void', 0, ?, ?)`
      await sql(insert, [voidPayload.movementId, first.sessionId, at, movement.movementId])
      await expect(sql(insert, [randomUUID(), first.sessionId, at, movement.movementId])).rejects.toMatchObject({ code: '23505' })
      const before = await snapshot()
      expect(await service.voidMovement({ ...voidPayload, movementId: randomUUID() })).toEqual({
        kind: 'invalid', message: 'void target is already voided',
      })
      expect(await snapshot()).toEqual(before)
    })

    it('two concurrent voids record exactly one reversal', async () => {
      await service.openSession(first)
      await service.recordMovement(movement)
      const outcomes = await Promise.all([
        service.voidMovement(voidPayload), service.voidMovement({ ...voidPayload, movementId: randomUUID() }),
      ])
      expect(outcomes.filter(outcome => outcome.kind === 'ok')).toHaveLength(1)
      expect(outcomes).toContainEqual({ kind: 'invalid', message: 'void target is already voided' })
      const [stored] = await sql("select id from tally_register_movement where type = 'void'")
      expect(await sql('select voided_by from tally_register_movement where id = ?', [movement.movementId])).toEqual([{ voided_by: stored.id }])
    })

    it('submits closure 1 and raises the counters, never lowering the perpetual totals', async () => {
      await service.openSession(first)
      const submitted = closure()
      const sessionsBefore = await sql('select * from tally_register_session')
      expect(await service.submitClosure(submitted)).toEqual({
        kind: 'ok', register: { counters: { lastClosureNumber: 1, perpetualSalesTotalMinor: 5000, perpetualRefundsTotalMinor: 100 },
          closure: { serverClosureId: submitted.closureId, number: 1 } },
      })
      expect(await sql('select * from tally_register_session')).toEqual(sessionsBefore)
      expect(await sql('select * from tally_register_closure')).toEqual([expect.objectContaining({
        id: submitted.closureId, session_id: first.sessionId, register_id: first.registerId, number: 1,
        business_day: first.businessDay, opened_at: first.openedAt, closed_at: at, closed_by: 'cashier', approved_by: 'manager',
        till_expected: submitted.tillExpected, counted: submitted.counted, expected: null, variance: null,
        period_sales_total_minor: '5000', period_refunds_total_minor: '100', perpetual_sales_total_minor: '5000',
        perpetual_refunds_total_minor: '100', unsynced_count: 1, unsynced_total_minor: '200',
        software_version: '2.0.0', order_ids: ['order-1'], movement_ids: [movement.movementId],
      })])
      await service.transition({ sessionId: first.sessionId, status: 'closed', at })
      await service.openSession(second)
      const next = closure({ sessionId: second.sessionId, number: 2, perpetualSalesTotalMinor: 10, perpetualRefundsTotalMinor: 0 })
      expect(await service.submitClosure(next)).toEqual({
        kind: 'ok', register: { counters: { lastClosureNumber: 2, perpetualSalesTotalMinor: 5000, perpetualRefundsTotalMinor: 100 },
          closure: { serverClosureId: next.closureId, number: 2 } },
      })
      expect(await sql('select perpetual_sales_total_minor, perpetual_refunds_total_minor from tally_register_closure where id = ?', [next.closureId]))
        .toEqual([{ perpetual_sales_total_minor: '10', perpetual_refunds_total_minor: '0' }])
    })

    it('counters and closure totals above 2^31 are stored and returned as numbers', async () => {
      await service.openSession(first)
      const submitted = closure({
        perpetualSalesTotalMinor: 3_000_000_000, perpetualRefundsTotalMinor: 3_000_000_000,
        periodSalesTotalMinor: 2_500_000_000, periodRefundsTotalMinor: 2_500_000_000, unsyncedTotalMinor: 2_500_000_000,
      })
      const counters = { lastClosureNumber: 1, perpetualSalesTotalMinor: 3_000_000_000, perpetualRefundsTotalMinor: 3_000_000_000 }
      expect(await service.submitClosure(submitted)).toEqual({
        kind: 'ok', register: { counters, closure: { serverClosureId: submitted.closureId, number: 1 } },
      })
      expect(await service.registerState(first.registerId)).toMatchObject({ counters })
      expect(await sql('select perpetual_sales_total_minor, perpetual_refunds_total_minor from tally_register')).toEqual([
        { perpetual_sales_total_minor: '3000000000', perpetual_refunds_total_minor: '3000000000' },
      ])
      expect(await sql('select * from tally_register_closure')).toEqual([expect.objectContaining({
        period_sales_total_minor: '2500000000', period_refunds_total_minor: '2500000000',
        perpetual_sales_total_minor: '3000000000', perpetual_refunds_total_minor: '3000000000',
        unsynced_total_minor: '2500000000',
      })])
    })

    it('keeps bigint-safe register totals and returns numeric counters', async () => {
      await service.openSession(first)
      const total = Number.MAX_SAFE_INTEGER
      await sql('update tally_register set perpetual_sales_total_minor = ? where id = ?', [total, first.registerId])
      expect(await service.submitClosure(closure())).toMatchObject({
        kind: 'ok', register: { counters: { lastClosureNumber: 1, perpetualSalesTotalMinor: total, perpetualRefundsTotalMinor: 100 } },
      })
      expect(await service.registerState(first.registerId)).toMatchObject({ counters: { perpetualSalesTotalMinor: total } })
    })

    it('refuses a closure number that is not last + 1 with register_closure_number_invalid and the counters', async () => {
      await service.openSession(first)
      const before = await snapshot()
      for (const number of [0, 2]) {
        expect(await service.submitClosure(closure({ number }))).toEqual({
          kind: 'conflict', code: 'register_closure_number_invalid', data: { counters: zero },
        })
      }
      expect(await snapshot()).toEqual(before)
    })

    it('refuses a second closure for a session with register_closure_exists and its id', async () => {
      await service.openSession(first)
      const submitted = closure()
      await service.submitClosure(submitted)
      const before = await snapshot()
      expect(await service.submitClosure(closure({ number: 2 }))).toEqual({
        kind: 'conflict', code: 'register_closure_exists', data: { closureId: submitted.closureId },
      })
      expect(await snapshot()).toEqual(before)
    })

    it('checks closure session, replay, register mismatch, existing closure and number in order', async () => {
      await service.openSession(first)
      const submitted = closure()
      await service.submitClosure(submitted)
      const before = await snapshot()
      expect(await service.submitClosure({ ...submitted, sessionId: randomUUID() })).toEqual({ kind: 'invalid', message: 'unknown session' })
      expect(await service.submitClosure({ ...submitted, registerId: randomUUID(), number: 99 })).toEqual({
        kind: 'ok', register: { counters: { lastClosureNumber: 1, perpetualSalesTotalMinor: 5000, perpetualRefundsTotalMinor: 100 },
          closure: { serverClosureId: submitted.closureId, number: 1 } },
      })
      expect(await service.submitClosure(closure({ registerId: randomUUID(), number: 99 }))).toEqual({
        kind: 'invalid', message: "closure registerId does not match the session's register",
      })
      expect(await service.submitClosure(closure({ number: 99 }))).toEqual({
        kind: 'conflict', code: 'register_closure_exists', data: { closureId: submitted.closureId },
      })
      expect(await snapshot()).toEqual(before)
    })

    it('two concurrent opens for one register: exactly one wins', async () => {
      // Pre-existing drawers must be protected by the partial unique index too.
      await sql('insert into tally_register (id) values (?)', [first.registerId])
      const outcomes = await Promise.all([service.openSession(first), service.openSession(second)])
      expect(outcomes.filter(outcome => outcome.kind === 'ok')).toHaveLength(1)
      const rows = await sql('select id from tally_register_session')
      expect(rows).toHaveLength(1)
      expect(outcomes).toContainEqual({ kind: 'conflict', code: 'register_session_already_open', data: { sessionId: rows[0].id } })
    })

    it("a movement racing its session's closure never commits after the closure", async () => {
      await service.openSession(first)
      await sql(`create function delay_movement_insert() returns trigger language plpgsql as $$
        begin
          if tg_table_name = 'tally_register_movement' then perform pg_sleep(1); end if;
          new.created_at = clock_timestamp(); return new;
        end $$`)
      for (const table of ['tally_register_movement', 'tally_register_closure']) {
        await sql(`create trigger time_racing_insert before insert on ${table}
          for each row execute function delay_movement_insert()`)
      }
      const pendingMovement = service.recordMovement(movement)
      try {
        let sleeping = false
        for (let attempt = 0; attempt < 100 && !sleeping; attempt++) {
          ;[{ sleeping }] = await sql(`select exists(select 1 from pg_stat_activity where datname = current_database()
            and wait_event = 'PgSleep' and query like 'insert into tally_register_movement%') as sleeping`)
          if (!sleeping) await sql('select pg_sleep(0.01)')
        }
        expect(sleeping).toBe(true)
        const [result, submitted] = await Promise.all([pendingMovement, service.submitClosure(closure())])
        expect(submitted).toMatchObject({ kind: 'ok' })
        const rows = await sql(`select m.id, m.created_at < c.created_at as before_closure
          from tally_register_movement m join tally_register_closure c on c.session_id = m.session_id`)
        if (result.kind === 'ok') {
          expect(rows).toEqual([{ id: movement.movementId, before_closure: true }])
        } else {
          expect(result).toEqual({ kind: 'conflict', code: 'register_session_closed' })
          expect(rows).toEqual([])
        }
      } finally {
        await pendingMovement
        for (const table of ['tally_register_movement', 'tally_register_closure']) {
          await sql(`drop trigger time_racing_insert on ${table}`)
        }
        await sql('drop function delay_movement_insert()')
      }
    })

    it('two concurrent closures with the same number: exactly one wins, the other gets register_closure_number_invalid or register_closure_exists', async () => {
      await service.openSession(first)
      await service.transition({ sessionId: first.sessionId, status: 'closed', at })
      await service.openSession(second)
      // Delay real PostgreSQL inserts so removing both numbering protections exposes the race.
      await sql(`create function delay_closure_insert() returns trigger language plpgsql as $$
        begin perform pg_sleep(0.2); return new; end $$`)
      await sql(`create trigger delay_closure_insert before insert on tally_register_closure
        for each row execute function delay_closure_insert()`)
      try {
        const outcomes = await Promise.all([
          service.submitClosure(closure()), service.submitClosure(closure({ sessionId: second.sessionId })),
        ])
        expect(outcomes.filter(outcome => outcome.kind === 'ok')).toHaveLength(1)
        expect(outcomes.filter(outcome => outcome.kind === 'conflict')).toEqual([
          expect.objectContaining({ code: expect.stringMatching(/^register_closure_(number_invalid|exists)$/) }),
        ])
        expect(await sql('select id from tally_register_closure')).toHaveLength(1)
        expect(await service.registerState(first.registerId)).toMatchObject({
          counters: { lastClosureNumber: 1, perpetualSalesTotalMinor: 5000, perpetualRefundsTotalMinor: 100 },
        })
      } finally {
        await sql('drop trigger delay_closure_insert on tally_register_closure')
        await sql('drop function delay_closure_insert()')
      }
    })

    it('registerState returns null for an unknown register, and the open session with counters', async () => {
      expect(await service.registerState(first.registerId)).toBeNull()
      await service.openSession(first)
      expect(await service.registerState(first.registerId)).toEqual({ session: { id: first.sessionId, status: 'open' }, counters: zero })
      await service.transition({ sessionId: first.sessionId, status: 'closed', at })
      await service.openSession(second)
      expect(await service.registerState(first.registerId)).toEqual({ session: { id: second.sessionId, status: 'open' }, counters: zero })
      await service.transition({ sessionId: second.sessionId, status: 'closed', at })
      expect(await service.registerState(first.registerId)).toEqual({ session: { id: second.sessionId, status: 'closed' }, counters: zero })
      await sql('insert into tally_register (id) values (?)', ['empty-drawer'])
      expect(await service.registerState('empty-drawer')).toEqual({ counters: zero })
    })

    it('a replayed open returns ok with the same session and writes nothing new', async () => {
      await service.openSession(first)
      let before = await snapshot()
      expect(await service.openSession(first)).toEqual({ kind: 'ok', register: { session: { id: first.sessionId, status: 'open' }, counters: zero } })
      expect(await snapshot()).toEqual(before)
      await service.transition({ sessionId: first.sessionId, status: 'closed', at })
      await service.openSession(second)
      before = await snapshot()
      expect(await service.openSession(first)).toEqual({ kind: 'ok', register: { session: { id: first.sessionId, status: 'closed' }, counters: zero } })
      expect(await snapshot()).toEqual(before)
    })

    it('a replayed movement and a replayed void return ok without new rows', async () => {
      await service.openSession(first)
      await service.recordMovement(movement)
      await service.voidMovement(voidPayload)
      for (const status of ['open', 'counting', 'closed'] as const) {
        await service.transition({ sessionId: first.sessionId, status, at })
        const before = await snapshot()
        const expected = { kind: 'ok', register: { session: { id: first.sessionId, status }, counters: zero } }
        expect(await service.recordMovement(movement)).toEqual(expected)
        expect(await service.voidMovement(voidPayload)).toEqual(expected)
        expect(await snapshot()).toEqual(before)
        expect(await sql('select id from tally_register_movement')).toHaveLength(2)
      }
    })

    it('a replayed closing transition returns ok and keeps the original closed_at', async () => {
      await service.openSession(first)
      const closing = { sessionId: first.sessionId, status: 'closed' as const, at, counted: { cash: 1 }, closedBy: 'cashier', approvedBy: 'manager' }
      await service.transition(closing)
      const before = await snapshot()
      expect(await service.transition(closing)).toEqual({ kind: 'ok', register: { session: { id: first.sessionId, status: 'closed' }, counters: zero } })
      expect(await service.transition({ ...closing, at: '2026-09-28T13:00:00Z', counted: { cash: 2 }, closedBy: 'someone-else' })).toMatchObject({ kind: 'ok' })
      expect(await snapshot()).toEqual(before)
      expect(await sql('select closed_at, closed_by, counted from tally_register_session')).toEqual([{ closed_at: at, closed_by: 'cashier', counted: { cash: 1 } }])
    })

    it('a replayed closure returns ok with its number and does not move the counters', async () => {
      await service.openSession(first)
      const submitted = closure()
      await service.submitClosure(submitted)
      await service.transition({ sessionId: first.sessionId, status: 'closed', at })
      await service.openSession(second)
      await service.submitClosure(closure({ sessionId: second.sessionId, number: 2, perpetualSalesTotalMinor: 6000, perpetualRefundsTotalMinor: 200 }))
      const before = await snapshot()
      expect(await service.submitClosure(submitted)).toEqual({
        kind: 'ok', register: { counters: { lastClosureNumber: 2, perpetualSalesTotalMinor: 6000, perpetualRefundsTotalMinor: 200 },
          closure: { serverClosureId: submitted.closureId, number: 1 } },
      })
      expect(await snapshot()).toEqual(before)
      expect(await sql('select id from tally_register_closure')).toHaveLength(2)
    })

    it('a void row stores a null reason', async () => {
      await service.openSession(first)
      await service.recordMovement(movement)
      await service.voidMovement(voidPayload)
      expect(await sql('select * from tally_register_movement where id = ?', [voidPayload.movementId])).toEqual([expect.objectContaining({
        type: 'void', amount_minor: '0', reason: null, voids: movement.movementId,
        created_at_client: voidPayload.createdAt, created_by: voidPayload.createdBy,
      })])
    })

    it('refuses mismatched session and movement ids without changing stored rows', async () => {
      await service.openSession(first)
      await service.openSession({ ...second, registerId: randomUUID() })
      await service.recordMovement(movement)
      await service.voidMovement(voidPayload)
      const before = await snapshot()
      expect(await service.openSession({ ...first, registerId: randomUUID() })).toEqual({ kind: 'invalid', message: 'session id belongs to another register' })
      expect(await service.recordMovement({ ...movement, sessionId: second.sessionId })).toEqual({ kind: 'invalid', message: 'movement id belongs to another session' })
      for (const payload of [
        { ...voidPayload, movementId: movement.movementId }, { ...voidPayload, voids: randomUUID() },
        { ...voidPayload, sessionId: second.sessionId },
      ]) {
        expect(await service.voidMovement(payload)).toEqual({ kind: 'invalid', message: 'movement id does not match this void' })
      }
      expect(await snapshot()).toEqual(before)
    })

    it('handles concurrent same-id replays without duplicate rows', async () => {
      const opens = await Promise.all([service.openSession(first), service.openSession(first)])
      expect(opens.every(outcome => outcome.kind === 'ok')).toBe(true)
      const movements = await Promise.all([service.recordMovement(movement), service.recordMovement(movement)])
      expect(movements.every(outcome => outcome.kind === 'ok')).toBe(true)
      const voids = await Promise.all([service.voidMovement(voidPayload), service.voidMovement(voidPayload)])
      expect(voids.every(outcome => outcome.kind === 'ok')).toBe(true)
      const submitted = closure()
      const closures = await Promise.all([service.submitClosure(submitted), service.submitClosure(submitted)])
      expect(closures.every(outcome => outcome.kind === 'ok')).toBe(true)
      expect(await sql('select id from tally_register_session')).toHaveLength(1)
      expect(await sql('select id from tally_register_movement')).toHaveLength(2)
      expect(await sql('select id from tally_register_closure')).toHaveLength(1)
    })
  },
})
