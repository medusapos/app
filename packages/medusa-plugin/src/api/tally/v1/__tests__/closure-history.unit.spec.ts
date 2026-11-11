import type { StoredClosure } from '../../../../modules/tally-register/types'
import { parseClosuresQuery, toClosureHistoryRow } from '../closure-history'

describe('parseClosuresQuery', () => {
  it('defaults limit to 50 with no before, from or to', () => {
    expect(parseClosuresQuery({})).toStrictEqual({ ok: true, query: { limit: 50 } })
  })

  it('reads limit, before, from and to, and accepts limits 1 and 100', () => {
    expect(parseClosuresQuery({ limit: '10', before: '7', from: '2026-01-01', to: '2026-01-31' }))
      .toStrictEqual({ ok: true, query: { limit: 10, before: 7, from: '2026-01-01', to: '2026-01-31' } })
    expect(parseClosuresQuery({ limit: '1' })).toStrictEqual({ ok: true, query: { limit: 1 } })
    expect(parseClosuresQuery({ limit: '100' })).toStrictEqual({ ok: true, query: { limit: 100 } })
    expect(parseClosuresQuery({ from: '2026-01-01', to: '2026-01-01' }))
      .toStrictEqual({ ok: true, query: { limit: 50, from: '2026-01-01', to: '2026-01-01' } })
  })

  it.each([
    [{ limit: '0' }, 'limit must be an integer from 1 to 100'],
    [{ limit: '101' }, 'limit must be an integer from 1 to 100'],
    [{ limit: '1.5' }, 'limit must be an integer from 1 to 100'],
    [{ limit: 'ten' }, 'limit must be an integer from 1 to 100'],
    [{ limit: ['1', '2'] }, 'limit must be an integer from 1 to 100'],
    [{ before: '0' }, 'before must be an integer >= 1'],
    [{ before: '-1' }, 'before must be an integer >= 1'],
    [{ before: 'x' }, 'before must be an integer >= 1'],
    [{ from: '2026-1-1' }, 'from must be a day (YYYY-MM-DD)'],
    [{ from: 'today' }, 'from must be a day (YYYY-MM-DD)'],
    [{ to: '20260101' }, 'to must be a day (YYYY-MM-DD)'],
    [{ from: '2026-01-02', to: '2026-01-01' }, 'from must not be after to'],
    [{ limit: '0', from: 'bad' }, 'limit must be an integer from 1 to 100'],
  ])('refuses %j with %s', (query, message) => {
    expect(parseClosuresQuery(query)).toStrictEqual({ ok: false, message })
  })
})

describe('toClosureHistoryRow', () => {
  const stored: StoredClosure = {
    id: 'closure_1', session_id: 'session_1', register_id: 'register_1', number: 1,
    business_day: '2026-01-01', opened_at: '2026-01-01T08:00:00.000Z', closed_at: '2026-01-01T10:00:00.000Z',
    opened_by: 'user_opener', closed_by: 'user_closer', approved_by: 'user_approver', approval_id: 'apv_1',
    store_key: 'store-a', device_name: 'Till 1', till_expected: { cash: 1100, card: 500 }, counted: { cash: 1000, card: 500 },
    period_sales_total_minor: 1000, period_refunds_total_minor: 100,
    perpetual_sales_total_minor: 3000, perpetual_refunds_total_minor: 200,
    unsynced_count: 2, unsynced_total_minor: 500, software_version: '1.0',
    order_ids: ['order_1'], movement_ids: ['movement_1'],
  }

  it('maps every stored field to its wire name, with approvalVerified true when an approval id is stored', () => {
    expect(toClosureHistoryRow(stored)).toStrictEqual({
      closureId: 'closure_1', sessionId: 'session_1', registerId: 'register_1', number: 1,
      businessDay: '2026-01-01', openedAt: '2026-01-01T08:00:00.000Z', closedAt: '2026-01-01T10:00:00.000Z',
      openedBy: 'user_opener', closedBy: 'user_closer', approvedBy: 'user_approver', approvalVerified: true,
      storeKey: 'store-a', deviceName: 'Till 1', tillExpected: { cash: 1100, card: 500 }, counted: { cash: 1000, card: 500 },
      periodSalesTotalMinor: 1000, periodRefundsTotalMinor: 100,
      perpetualSalesTotalMinor: 3000, perpetualRefundsTotalMinor: 200,
      unsyncedCount: 2, unsyncedTotalMinor: 500, softwareVersion: '1.0',
      orderIds: ['order_1'], movementIds: ['movement_1'],
    })
  })

  it('leaves out null optional fields, and approvalVerified is false without an approval id', () => {
    expect(toClosureHistoryRow({ ...stored, business_day: null, closed_by: null, approved_by: null,
      approval_id: null, store_key: null, device_name: null, opened_by: null })).toStrictEqual({
      closureId: 'closure_1', sessionId: 'session_1', registerId: 'register_1', number: 1,
      openedAt: '2026-01-01T08:00:00.000Z', closedAt: '2026-01-01T10:00:00.000Z', approvalVerified: false,
      tillExpected: { cash: 1100, card: 500 }, counted: { cash: 1000, card: 500 },
      periodSalesTotalMinor: 1000, periodRefundsTotalMinor: 100,
      perpetualSalesTotalMinor: 3000, perpetualRefundsTotalMinor: 200,
      unsyncedCount: 2, unsyncedTotalMinor: 500, softwareVersion: '1.0',
      orderIds: ['order_1'], movementIds: ['movement_1'],
    })
  })
})
