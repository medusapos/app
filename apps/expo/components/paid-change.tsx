// v2's paid-screen change header: a tick, the change as a heading, and what was paid and tendered. Screen only.
import type { JSX } from 'react';
import { View } from 'react-native';
import { Path } from 'react-native-svg';
import { Text, createSvgIcon } from '@tallyui/components';
import { formatMoney } from '@tallyui/core';
import { capturedMinor, type PosOrder, type SentOrder } from '@tallyui/pos';
import { changeDueMinor } from '../lib/change-due';

const TickIcon = createSvgIcon('TickIcon', () => <Path d="M5 12l5 5l10 -10" />);

/** What the customer handed over in cash: each cash payment's tendered amount, or its amount when none was keyed. */
export function cashTenderedMinor(payments: PosOrder['payments']): number {
  return payments.filter(payment => payment.method === 'cash')
    .reduce((sum, payment) => sum + (payment.tenderedMinor ?? payment.amountMinor), 0);
}

export function PaidChange({ order, posOrder }: { order: SentOrder; posOrder: PosOrder }): JSX.Element {
  const money = (amount: number) => formatMoney({ amount, currency: order.currency });
  const tenderedMinor = cashTenderedMinor(posOrder.payments);
  return <View testID="paid-change-due" className="items-center gap-3">
    {/* The icon strokes in currentColor, so the circle's text-success colours the tick. */}
    <View testID="paid-change-tick" className="h-24 w-24 items-center justify-center rounded-full bg-success/15 text-success">
      <TickIcon size={40} strokeWidth={3} />
    </View>
    <Text testID="paid-change-figure" accessibilityRole="header" className="text-5xl font-bold text-foreground">
      {`Change ${money(changeDueMinor(order))}`}
    </Text>
    <Text testID="paid-change-tendered" className="text-muted-foreground">
      {`Paid ${money(capturedMinor(posOrder.payments))} · tendered ${money(tenderedMinor)} in cash`}
    </Text>
  </View>;
}
