import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { formatClosureDate, minorToDecimal, type ClosureContext } from '@tallyui/pos';
import { ClosureHistoryError, dayBefore, fetchClosureHistory, type ClosureHistoryEntry } from '../lib/closure-history';
import type { Session } from '../lib/session';

const Row = ({ label, value }: { label: string; value: ReactNode }) =>
  <View className="min-h-11 flex-row items-center justify-between gap-3">
    <Text className="shrink-0 text-muted-foreground">{label}</Text>
    <Text className="shrink text-right tabular-nums text-foreground">{value}</Text>
  </View>;

export function EarlierClosures({ session, registerId, today, ctx }: {
  session: Session; registerId: string; today: string; ctx: ClosureContext;
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
      const page = await fetchClosureHistory(session, registerId, { to: dayBefore(today), ...(before === undefined ? {} : { before }) });
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

  useEffect(() => {
    void load();
    return () => { request.current++; };
  }, [session.baseUrl, session.token, registerId, today]);

  return <>
    <Text testID="earlier-closures-heading" className="text-lg font-semibold text-foreground">Earlier closures</Text>
    {loading && rows.length === 0 ? <Text testID="earlier-closures-loading" className="text-foreground">Loading…</Text> : null}
    {rows.map(({ closureId, number, businessDay, openedAt, closedAt, periodSalesTotalMinor }) =>
      <View key={closureId} testID={`earlier-closure-${closureId}`}>
        <Text className="font-semibold text-foreground">{`Closure #${number}`}</Text>
        <Row label="Day" value={businessDay ?? openedAt.slice(0, 10)} />
        <Row label="Closed" value={formatClosureDate(closedAt, { timezone: ctx.timezone, locale: ctx.locale }).datetime} />
        <Row label="Sales" value={ctx.formatMoney(minorToDecimal(periodSalesTotalMinor, ctx.exponent))} />
      </View>)}
    {!loading && rows.length === 0 && !error ? <Text testID="earlier-closures-empty" className="text-foreground">No earlier closures</Text> : null}
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
