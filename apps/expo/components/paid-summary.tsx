import type { JSX } from 'react';
import { View } from 'react-native';
import { OrderSummaryLine, Text, orderReference } from '@tallyui/components';
import { formatMoney } from '@tallyui/core';
import { buildReceiptData, capturedMinor, type PosOrder, type SentOrder } from '@tallyui/pos';
import { SummaryPayments } from './summary-payments';

export function PaidSummary({ order, posOrder, storeName, taxLabel, formatDate, awaiting }: {
  order: SentOrder;
  posOrder: PosOrder;
  storeName: string;
  taxLabel: (ratePpm: number) => string;
  formatDate: (iso: string) => string;
  /** The paid screen's awaiting-store state (useAwaitingStore): each payment then reads "Recorded offline", as v2. */
  awaiting: boolean;
}): JSX.Element {
  const receipt = buildReceiptData(order, { storeName });
  const { totals } = receipt;
  const paidMinor = capturedMinor(posOrder.payments);
  return <View testID="paid-summary" dataSet={{ print: 'hide' }} className="flex-1 bg-card border-l border-border gap-3 p-4">
    <Text className="text-foreground">{`#${orderReference(posOrder)} · ${order.customer?.name ?? 'Guest'} · ${formatDate(posOrder.createdAt)}`}</Text>
    {receipt.lineItems.map((line, index) => <View key={index} className="flex-row items-start gap-3">
      <Text className="text-foreground">{line.quantity}</Text>
      <Text className="flex-1 text-foreground">{line.name}</Text>
      <Text className="text-foreground">{formatMoney({ amount: line.displayAmountMinor, currency: order.currency })}</Text>
    </View>)}
    <OrderSummaryLine label="Subtotal" amount={formatMoney({ amount: totals.subtotalMinor, currency: order.currency })!} />
    {totals.discountMinor > 0 && <OrderSummaryLine label="Discount"
      amount={`−${formatMoney({ amount: totals.discountMinor, currency: order.currency })}`} />}
    {receipt.fees.map((fee, index) => <OrderSummaryLine key={index} label={fee.name}
      amount={formatMoney({ amount: fee.amountMinor, currency: order.currency })!} />)}
    {receipt.shipping.map((shipping, index) => <OrderSummaryLine key={index} label={shipping.name}
      amount={formatMoney({ amount: shipping.amountMinor, currency: order.currency })!} />)}
    {totals.taxLines.map((line, index) => <OrderSummaryLine key={index}
      label={`${totals.taxInclusive ? 'incl. ' : ''}${taxLabel(line.ratePpm)}`}
      amount={formatMoney({ amount: line.amountMinor, currency: order.currency })!} />)}
    <SummaryPayments currency={order.currency} totalMinor={totals.totalMinor} paidMinor={paidMinor}
      payments={posOrder.payments.map((payment) => ({ id: payment.id, label: payment.method === 'cash' ? 'Cash' : 'Card terminal',
        amountMinor: payment.amountMinor, tenderedMinor: payment.tenderedMinor, changeMinor: payment.changeMinor,
        // A stored payment is always captured (finalizeOrder refuses any other status); v2's paid summary shows it as Captured.
        status: 'captured' as const, recordedOffline: awaiting }))} />
    {paidMinor >= totals.totalMinor && <Text testID="paid-in-full" className="text-success">Paid in full</Text>}
  </View>;
}
