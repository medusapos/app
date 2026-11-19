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
  /** v2's muted "Recorded offline" line under the payment, while the sale is awaiting the store. */
  recordedOffline?: boolean;
};

// The tender pane's ledger tones (TallyUI TenderPane) as v2's status dot, so the summary and the ledger agree.
const STATUS_TONE: Record<PaymentLegStatus, string> = {
  pending: 'bg-muted-foreground', authorized: 'bg-success', captured: 'bg-success',
  failed: 'bg-destructive', voided: 'bg-muted-foreground',
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
        {payment.status !== undefined && <View className="flex-row items-center gap-1">
          <View className={`h-2 w-2 rounded-full ${STATUS_TONE[payment.status]}`} />
          <Text testID={`summary-payment-${payment.id}-status`}
            className="text-sm text-foreground">{t(`pos_checkout.status_${payment.status}`)}</Text>
        </View>}
      </View>
      {payment.tenderedMinor !== undefined && <Text testID={`summary-payment-${payment.id}-tendered`} className="text-muted-foreground">
        {`Tendered ${money(payment.tenderedMinor)} · change ${money(payment.changeMinor ?? 0)}`}
      </Text>}
      {payment.recordedOffline && <Text testID={`summary-recorded-offline-${payment.id}`}
        className="text-muted-foreground">Recorded offline</Text>}
    </View>)}
    <OrderSummaryLine testID="summary-total" label="Total" bold amount={money(totalMinor)} />
    <OrderSummaryLine testID="summary-paid" label="Paid" amount={money(paidMinor)} />
    {remainingMinor !== undefined && <OrderSummaryLine testID="summary-remaining" label="Remaining" bold amount={money(remainingMinor)} />}
    {changeMinor !== undefined && changeMinor > 0 && <OrderSummaryLine testID="summary-change" label="Change" amount={money(changeMinor)} />}
  </View>;
}
