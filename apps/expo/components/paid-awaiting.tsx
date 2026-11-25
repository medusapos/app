// v2's paid-screen headline for a sale saved while the store was unreachable: a clock, the change (or what was paid)
// as a heading, and "Awaiting store" in front of the line the sent sale would show. Screen only.
import { useRef, type JSX } from 'react';
import { View } from 'react-native';
import { Path } from 'react-native-svg';
import { Text, createSvgIcon } from '@tallyui/components';
import { formatMoney } from '@tallyui/core';
import { capturedMinor, type OutboxState, type PosOrder, type SentOrder } from '@tallyui/pos';
import { cashTenderedMinor } from './paid-change';
import { changeDueMinor } from '../lib/change-due';

const ClockIcon = createSvgIcon('ClockIcon', () => <>
  <Path d="M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0" />
  <Path d="M12 7v5l3 3" />
</>);

/** The sale's distinct payment methods in payment order, as the paid summary names them. */
export function paymentMethodsLabel(posOrder: PosOrder): string {
  const labels = posOrder.payments.map(payment => payment.method === 'cash' ? 'Cash' : 'Card terminal');
  return [...new Set(labels)].join(' + ');
}

/**
 * True while the paid sale waits for the store: its outbox entry is pending and the till is offline or a send has
 * already failed. Once on it holds for that entry until the entry is no longer pending, so a retry starting (which
 * clears nextAttemptAt) or the till coming back online does not flicker the headline off before the store has it.
 */
export function useAwaitingStore(entry: Pick<PosOrder, 'id' | 'syncStatus'> | undefined, online: boolean,
  outboxState: Pick<OutboxState, 'nextAttemptAt'>): boolean {
  const latched = useRef<string | undefined>(undefined);
  const pending = entry?.syncStatus === 'pending';
  if (!pending) latched.current = undefined;
  else if (latched.current !== entry.id && (!online || outboxState.nextAttemptAt !== undefined)) latched.current = entry.id;
  return pending && latched.current === entry.id;
}

export function PaidAwaiting({ order, posOrder }: { order: SentOrder; posOrder: PosOrder }): JSX.Element {
  const money = (amount: number) => formatMoney({ amount, currency: order.currency });
  const paid = money(capturedMinor(posOrder.payments));
  const change = changeDueMinor(order);
  const changeDue = change > 0;
  // As v2: the change stays the headline, and a sale with more than one payment ends the line with the count.
  const line = changeDue ? `Paid ${paid} · tendered ${money(cashTenderedMinor(posOrder.payments))} in cash`
    : paymentMethodsLabel(posOrder);
  const count = posOrder.payments.length > 1 ? ` · ${posOrder.payments.length} payments` : '';
  return <View testID="paid-awaiting" className="items-center gap-3">
    {/* The icon strokes in currentColor, so the circle's text-warning colours the clock. */}
    <View testID="paid-awaiting-clock" className="h-24 w-24 items-center justify-center rounded-full bg-warning/15 text-warning">
      <ClockIcon size={40} strokeWidth={2} />
    </View>
    <Text testID="paid-awaiting-figure" accessibilityRole="header" className="text-5xl font-bold text-foreground">
      {changeDue ? `Change ${money(change)}` : `Paid ${paid}`}
    </Text>
    <Text testID="paid-awaiting-status" className="text-muted-foreground">
      <Text className="text-warning">Awaiting store</Text>
      {` · ${line}${count}`}
    </Text>
  </View>;
}
