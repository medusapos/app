import type { JSX } from 'react';
import { View } from 'react-native';
import { OrderSummaryLine, Text, orderReference } from '@tallyui/components';
import { formatMoney } from '@tallyui/core';
import { buildReceiptData, capturedMinor, type PosOrder, type SentOrder } from '@tallyui/pos';

export function PaidSummary({ order, posOrder, storeName, taxLabel, formatDate }: {
  order: SentOrder;
  posOrder: PosOrder;
  storeName: string;
  taxLabel: (ratePpm: number) => string;
  formatDate: (iso: string) => string;
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
    <Text className="font-semibold text-foreground">Payments</Text>
    {posOrder.payments.map(payment => <View key={payment.id} className="gap-1">
      <OrderSummaryLine label={payment.method === 'cash' ? 'Cash' : 'Card terminal'}
        amount={formatMoney({ amount: payment.amountMinor, currency: order.currency })!} />
      {payment.tenderedMinor !== undefined && <Text className="text-muted-foreground">
        {`Tendered ${formatMoney({ amount: payment.tenderedMinor, currency: order.currency })} · change ${formatMoney({ amount: payment.changeMinor ?? 0, currency: order.currency })}`}
      </Text>}
    </View>)}
    <OrderSummaryLine label="Total" bold amount={formatMoney({ amount: totals.totalMinor, currency: order.currency })!} />
    <OrderSummaryLine label="Paid" amount={formatMoney({ amount: paidMinor, currency: order.currency })!} />
    {paidMinor >= totals.totalMinor && <Text testID="paid-in-full" className="text-success">Paid in full</Text>}
  </View>;
}
