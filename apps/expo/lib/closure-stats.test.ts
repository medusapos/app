import { describe, expect, it } from 'vitest';
import type { Closure } from '@tallyui/pos';
import type { ClosureHistoryEntry } from './closure-history';
import { closureStats } from './closure-stats';
import type { OpenSessionSummary } from './open-session';

const open = (overrides: Partial<OpenSessionSummary> = {}): OpenSessionSummary => ({ status: 'open',
  openedAt: '2026-09-11T08:00:00Z', openedBy: 'ana', salesCount: 2, expectedCashMinor: 4000, floatMinor: 1000, ...overrides });

function closure(id: string, float: number | null, cash: { expected: number; counted: number; variance: number }): Closure {
  return {
    id, session_id: `session-${id}`, register_id: 'register-1', store_key: 'https://shop.test', business_day: '2026-09-11', number: 1,
    opened_at: '2026-09-11T08:00:00Z', closed_at: '2026-09-11T17:00:00Z',
    till_expected: { cash: cash.expected }, expected: { cash: cash.expected }, counted: { cash: cash.counted },
    variance: { cash: cash.variance }, period_sales_total_minor: 0, period_refunds_total_minor: 0, perpetual_sales_total_minor: 0,
    perpetual_refunds_total_minor: 0, unsynced_count: 0, unsynced_total_minor: 0, software_version: 'test',
    breakdowns: float === null ? {} : { opening_float: { expected_minor: float, counted_minor: float } },
    order_ids: [], movement_ids: [], print_count: 0,
  };
}

const entry = (overrides: Partial<ClosureHistoryEntry> = {}): ClosureHistoryEntry => ({ closureId: 'h1', number: 9,
  openedAt: '2026-09-10T08:00:00Z', closedAt: '2026-09-10T17:00:00Z', periodSalesTotalMinor: 0, ...overrides });

describe('closureStats', () => {
  it('is all zeros with nothing to show', () => {
    expect(closureStats({ open: null, closures: [], earlier: [], local: [] })).toEqual({ sessions: 0, open: 0, closed: 0,
      floatsMinor: 0, floatsKnown: 0, activityMinor: 0, activityKnown: 0, countedMinor: 0, counts: 0, varianceMinor: 0,
      short: 0, over: 0, exact: 0 });
  });

  it('sums the open session, the till\'s closures and a store closure the till has no copy of', () => {
    const a = closure('a', 1000, { expected: 5000, counted: 4800, variance: -200 });
    const b = closure('b', 500, { expected: 900, counted: 900, variance: 0 });
    const c = entry({ closureId: 'c', tillExpected: { cash: 700 }, counted: { cash: 750 } });
    expect(closureStats({ open: open(), closures: [a, b], earlier: [c], local: [a, b] })).toEqual({ sessions: 4, open: 1,
      closed: 3, floatsMinor: 2500, floatsKnown: 3, activityMinor: 7400, activityKnown: 3, countedMinor: 6450, counts: 3,
      varianceMinor: -150, short: 1, over: 1, exact: 1 });
  });

  it('a blind open session adds its float but no cash activity', () => {
    expect(closureStats({ open: open({ expectedCashMinor: null }), closures: [], earlier: [], local: [] })).toMatchObject({
      sessions: 1, open: 1, floatsMinor: 1000, floatsKnown: 1, activityMinor: 0, activityKnown: 0 });
  });

  it('a store closure the till has locally takes the float from the till\'s copy', () => {
    const own = closure('h1', 800, { expected: 2000, counted: 2000, variance: 0 });
    const stats = closureStats({ open: null, closures: [], local: [own],
      earlier: [entry({ tillExpected: { cash: 2000 }, counted: { cash: 1900 } })] });
    expect(stats).toMatchObject({ sessions: 1, closed: 1, floatsMinor: 800, floatsKnown: 1, activityMinor: 1200,
      activityKnown: 1, countedMinor: 1900, counts: 1, varianceMinor: -100, short: 1 });
  });

  it('a store closure without counted or expected figures counts as a closed session only', () => {
    expect(closureStats({ open: null, closures: [], earlier: [entry()], local: [] })).toEqual({ sessions: 1, open: 0,
      closed: 1, floatsMinor: 0, floatsKnown: 0, activityMinor: 0, activityKnown: 0, countedMinor: 0, counts: 0,
      varianceMinor: 0, short: 0, over: 0, exact: 0 });
  });

  it('an earlier closure that counted cash only is exact, not short by its uncounted card takings', () => {
    const stats = closureStats({ open: null, closures: [], local: [],
      earlier: [entry({ counted: { cash: 1000 }, tillExpected: { cash: 1000, external: 50000 } })] });
    expect(stats).toMatchObject({ closed: 1, countedMinor: 1000, counts: 1, varianceMinor: 0, short: 0, over: 0, exact: 1 });
  });
});
