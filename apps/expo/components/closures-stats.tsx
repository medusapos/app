import { View } from 'react-native';
import { minorToDecimal, type ClosureContext } from '@tallyui/pos';
import type { ClosureStats } from '../lib/closure-stats';
import { AppText as Text } from './app-text';

/** v2's row of five stat cards above the Closures list (tablet and wider). */
export function ClosuresStats({ stats, ctx }: { stats: ClosureStats; ctx: ClosureContext }) {
  const money = (minor: number) => ctx.formatMoney(minorToDecimal(minor, ctx.exponent));
  const signed = (minor: number) => minor > 0 ? `+${money(minor)}` : minor < 0 ? `−${money(-minor)}` : money(0);
  const of = (known: number) => ` · ${known} of ${stats.sessions} sessions`;
  const cards: { id: string; label: string; value: string; detail: string; tone?: string }[] = [
    { id: 'sessions', label: 'Sessions', value: String(stats.sessions), detail: `${stats.open} open · ${stats.closed} closed` },
    { id: 'cash-open', label: 'Cash at open', value: money(stats.floatsMinor),
      detail: stats.floatsKnown === stats.sessions ? 'floats' : `floats${of(stats.floatsKnown)}` },
    { id: 'activity', label: 'Cash activity', value: signed(stats.activityMinor),
      detail: `sales − refunds ± movements${stats.activityKnown < stats.sessions ? of(stats.activityKnown) : ''}` },
    { id: 'cash-close', label: 'Cash at close', value: money(stats.countedMinor),
      detail: stats.counts === 1 ? '1 count' : `${stats.counts} counts` },
    { id: 'discrepancy', label: 'Discrepancy', value: signed(stats.varianceMinor),
      detail: `${stats.short} short · ${stats.over} over · ${stats.exact} exact`,
      tone: stats.varianceMinor < 0 ? 'text-destructive' : undefined },
  ];
  return <View testID="closures-stats" className="flex-row rounded-lg border border-border bg-card">
    {cards.map((card, index) => <View key={card.id} testID={`closures-stat-${card.id}`}
      className={`flex-1 gap-0.5 p-3${index > 0 ? ' border-l border-border' : ''}`}>
      <Text className="text-sm text-foreground">{card.label}</Text>
      <Text testID={`closures-stat-${card.id}-value`}
        className={`text-lg font-semibold tabular-nums ${card.tone ?? 'text-foreground'}`}>{card.value}</Text>
      <Text testID={`closures-stat-${card.id}-detail`} className="text-sm text-muted-foreground">{card.detail}</Text>
    </View>)}
  </View>;
}
