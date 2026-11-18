import type { Closure } from '@tallyui/pos';
import type { ClosureHistoryEntry } from './closure-history';
import type { OpenSessionSummary } from './open-session';
import { closureTableRow, historyClosure, historyTableRow } from './reports';

/** v2's five stat cards above Closures, over exactly the sessions the list shows. */
export type ClosureStats = {
  sessions: number; open: number; closed: number;
  /** Cash at open: the floats of the sessions whose float is known, and how many those are. */
  floatsMinor: number; floatsKnown: number;
  /** Cash activity: expected cash − float, over the sessions where both are known. */
  activityMinor: number; activityKnown: number;
  /** Cash at close: counted totals of the closures that have one. */
  countedMinor: number; counts: number;
  /** Discrepancy: net variance and how many closures were short, over, exact. */
  varianceMinor: number; short: number; over: number; exact: number;
};

/** The float a till closure opened with: TallyUI's `breakdowns.opening_float.counted_minor`, else unknown. */
function floatOf(closure: Closure): number | null {
  const float = closure.breakdowns.opening_float as { counted_minor?: unknown } | undefined;
  const minor = float?.counted_minor;
  return typeof minor === 'number' && Number.isFinite(minor) ? minor : null;
}

export function closureStats({ open, closures, earlier, local }: { open: OpenSessionSummary | null; closures: Closure[];
  earlier: ClosureHistoryEntry[]; local: Closure[] }): ClosureStats {
  const stats: ClosureStats = { sessions: 0, open: 0, closed: 0, floatsMinor: 0, floatsKnown: 0, activityMinor: 0,
    activityKnown: 0, countedMinor: 0, counts: 0, varianceMinor: 0, short: 0, over: 0, exact: 0 };
  const add = (float: number | null, expectedCash: number | null, countedMinor: number | null, varianceMinor: number | null) => {
    stats.sessions += 1;
    if (float !== null) { stats.floatsMinor += float; stats.floatsKnown += 1; }
    if (float !== null && expectedCash !== null) { stats.activityMinor += expectedCash - float; stats.activityKnown += 1; }
    if (countedMinor !== null) { stats.countedMinor += countedMinor; stats.counts += 1; }
    if (varianceMinor !== null) {
      stats.varianceMinor += varianceMinor;
      if (varianceMinor < 0) stats.short += 1; else if (varianceMinor > 0) stats.over += 1; else stats.exact += 1;
    }
  };
  if (open) { stats.open += 1; add(open.floatMinor, open.expectedCashMinor, null, null); }
  for (const row of closures) {
    const { countedMinor, varianceMinor } = closureTableRow(row, {});
    stats.closed += 1;
    add(floatOf(row), row.till_expected.cash ?? 0, countedMinor, varianceMinor);
  }
  for (const entry of earlier) {
    const own = historyClosure(entry, local);
    const { countedMinor, varianceMinor } = historyTableRow(entry, '', {});
    stats.closed += 1;
    add(own?.frozen ? floatOf(own.closure) : null, entry.tillExpected ? entry.tillExpected.cash ?? 0 : null, countedMinor, varianceMinor);
  }
  return stats;
}
