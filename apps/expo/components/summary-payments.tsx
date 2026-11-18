import type { JSX } from 'react';
import { View } from 'react-native';
import { OrderSummaryLine, Text, useT } from '@tallyui/components';
import { formatMoney } from '@tallyui/core';
import type { PaymentLegStatus } from '@tallyui/pos';

export type SummaryPayment = {
  id: string; label: string; amountMinor: number;
  tenderedMinor?: number; changeMinor?: number;
  /** Shown beside the amount (ledger label and tone) only when given. */
  status?: PaymentLegStatus;
};

// The tender pane's ledger tones (TallyUI TenderPane), so the summary and the ledger agree.
const STATUS_TONE: Record<PaymentLegStatus, string> = {
  pending: 'text-muted-foreground', authorized: 'text-success', captured: 'text-success',
  failed: 'text-destructive', voided: 'text-muted-foreground',
};

/** The Payments block shared by the paid screen's summary and the tender's order summary, then Total, Paid (and Remaining). */
export function SummaryPayments({ currency, payments, totalMinor, paidMinor, remainingMinor, changeMinor, testID }: {
  currency: string;
  payments: readonly SummaryPayment[];
  totalMinor: number;
  paidMinor: number;
  /** Rendered as a bold "Remaining" row only when given. */
  remainingMinor?: number;
  /** Rendered as a "Change" row only when given and above zero. */
  changeMinor?: number;
  testID?: string;
}): JSX.Element {
  const t = useT();
  const money = (amount: number) => formatMoney({ amount, currency })!;
  return <View testID={testID} className="gap-3">
    <Text className="font-semibold text-foreground">Payments</Text>
    {payments.map(payment => <View key={payment.id} testID={`summary-payment-${payment.id}`} className="gap-1">
      <View className="flex-row items-center gap-3">
        <OrderSummaryLine className="flex-1" label={payment.label} amount={money(payment.amountMinor)} />
        {payment.status !== undefined && <Text testID={`summary-payment-${payment.id}-status`}
          className={`text-sm font-semibold ${STATUS_TONE[payment.status]}`}>{t(`pos_checkout.status_${payment.status}`)}</Text>}
      </View>
      {payment.tenderedMinor !== undefined && <Text testID={`summary-payment-${payment.id}-tendered`} className="text-muted-foreground">
        {`Tendered ${money(payment.tenderedMinor)} · change ${money(payment.changeMinor ?? 0)}`}
      </Text>}
    </View>)}
    <OrderSummaryLine testID="summary-total" label="Total" bold amount={money(totalMinor)} />
    <OrderSummaryLine testID="summary-paid" label="Paid" amount={money(paidMinor)} />
    {remainingMinor !== undefined && <OrderSummaryLine testID="summary-remaining" label="Remaining" bold amount={money(remainingMinor)} />}
    {changeMinor !== undefined && changeMinor > 0 && <OrderSummaryLine testID="summary-change" label="Change" amount={money(changeMinor)} />}
  </View>;
}
