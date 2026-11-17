import { useEffect, useRef, useState } from 'react';
import { Pressable, Text } from 'react-native';
import type { Closure, ClosureContext } from '@tallyui/pos';
import { ClosureHistoryError, dayBefore, fetchClosureHistory, type ClosureHistoryEntry } from '../lib/closure-history';
import { byCashier, historyClosure, historyTableRow } from '../lib/reports';
import type { Session } from '../lib/session';
import { ClosureTable } from './closure-table';

export function EarlierClosures({ session, registerId, today, ctx, registerName, cashierNames, localClosures = [], onOpen,
  from, to = dayBefore(today), cashierId = null, heading = 'Earlier closures', onCashiers }: {
  session: Session; registerId: string; today: string; ctx: ClosureContext; registerName: string; cashierNames: Record<string, string>;
  localClosures?: Closure[]; onOpen?: (opened: { closure: Closure; frozen: boolean }) => void;
  from?: string; to?: string; cashierId?: string | null; heading?: string | null; onCashiers?: (ids: string[]) => void;
}) {
  const [rows, setRows] = useState<ClosureHistoryEntry[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [failedBefore, setFailedBefore] = useState<number>();
  const request = useRef(0);

  async function load(before?: number) {
    const id = ++request.current;
    setLoading(true);
    setError(null);
    if (before === undefined) { setRows([]); setMore(false); }
    try {
      const page = await fetchClosureHistory(session, registerId, { ...(from === undefined ? {} : { from }), to, ...(before === undefined ? {} : { before }) });
      if (id !== request.current) return;
      setRows((current) => before === undefined ? page.closures
        : [...current, ...page.closures.filter((row) => !current.some((entry) => entry.closureId === row.closureId))]);
      setMore(page.more);
    } catch (cause) {
      if (id !== request.current) return;
      setError(cause instanceof ClosureHistoryError ? cause.message : "Couldn't load earlier closures.");
      setFailedBefore(before);
    } finally {
      if (id === request.current) setLoading(false);
    }
  }

  const opened = (id: string) => {
    const entry = rows.find((row) => row.closureId === id);
    return entry ? historyClosure(entry, localClosures) : null;
  };

  useEffect(() => {
    void load();
    return () => { request.current++; };
  }, [session.baseUrl, session.token, registerId, today, from, to]);
  useEffect(() => {
    onCashiers?.([...new Set(rows.flatMap((row) => row.closedBy ? [row.closedBy] : []))]);
  }, [rows]);
  const shown = byCashier(rows, cashierId, (row) => row.closedBy);

  return <>
    {heading === null ? null : <Text testID="earlier-closures-heading" className="text-lg font-semibold text-foreground">{heading}</Text>}
    {loading && rows.length === 0 ? <Text testID="earlier-closures-loading" className="text-foreground">Loading…</Text> : null}
    <ClosureTable testID="earlier-closures-table" rowTestID={(id) => `earlier-closure-${id}`} ctx={ctx} today={today}
      rows={shown.map((r) => historyTableRow(r, registerName, cashierNames))}
      openable={onOpen ? (id) => opened(id) !== null : undefined}
      onOpen={onOpen ? (id) => { const closure = opened(id); if (closure) onOpen(closure); } : undefined} />
    {!loading && shown.length === 0 && !error ? <Text testID="earlier-closures-empty" className="text-foreground">
      {heading === null ? 'No closures in this period' : 'No earlier closures'}</Text> : null}
    {more ? <Pressable testID="earlier-closures-more" accessibilityRole="button" disabled={loading}
      className="min-h-11 items-center justify-center rounded-md px-4 border border-border"
      onPress={() => void load(rows[rows.length - 1].number)}>
      <Text className="text-foreground">{loading ? 'Loading…' : 'Load more'}</Text>
    </Pressable> : null}
    {error ? <>
      <Text testID="earlier-closures-error" accessibilityRole="alert" className="text-foreground">{error}</Text>
      <Pressable testID="earlier-closures-retry" accessibilityRole="button" onPress={() => void load(failedBefore)}>
        <Text className="text-foreground">Retry</Text>
      </Pressable>
    </> : null}
  </>;
}
