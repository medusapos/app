import { useContext, useEffect } from 'react';
import { Pressable, Text, View } from 'react-native';
import { formatMoney } from '@tallyui/core';
import { buildReceiptData, type Order } from '@tallyui/pos';
import type { StoreSettings } from '../lib/store-settings';
import { injectPrintStyle } from './print-style';
import { discountLabel } from './discount-form';
import { formatDate } from '../lib/format-date';
import { StripHeightContext } from './store-refused';

export function Receipt({ order, settings, cashier, registerId, newSale }: {
  order: Order; settings: StoreSettings; cashier: string; registerId: string; newSale: () => void;
}) {
  useEffect(injectPrintStyle, []);
  const stripHeight = useContext(StripHeightContext);
  const receipt = buildReceiptData(order, {
    storeName: settings.storeName, storeAddress: settings.location.addressLine, cashier, register: registerId,
  });
  const money = (amount: number) => formatMoney({ amount, currency: receipt.currency }) ?? '';
  const row = (label: string, amount: string, bold = false, key?: number) => <View key={key} accessibilityLabel={`${label}: ${amount}`} className="flex-row justify-between gap-4">
    <Text className={`text-foreground ${bold ? 'font-semibold' : ''}`}>{label}</Text>
    <Text className={`text-right text-foreground ${bold ? 'font-semibold' : ''}`}>{amount}</Text>
  </View>;
  const { totals } = receipt;
  const vat = totals.taxLines.map((line, index) =>
    row(`${totals.taxInclusive ? 'incl. ' : ''}VAT ${line.ratePpm / 10000}%`, money(line.amountMinor), false, index));
  return <>
    {stripHeight > 0 ? <View dataSet={{ print: 'hide' }} style={{ height: stripHeight, flexShrink: 0 }} /> : null}
    <View className="w-full max-w-md self-center gap-3 p-4 bg-card">
    <Text className="text-lg font-semibold text-foreground">{receipt.header.storeName}</Text>
    {receipt.header.storeAddress ? <Text className="text-muted-foreground">{receipt.header.storeAddress}</Text> : null}
    <Text className="text-foreground">Order {receipt.header.orderNumber.slice(-8)}</Text>
    <Text className="text-muted-foreground">{formatDate(receipt.header.date)}</Text>
    <Text className="text-muted-foreground">Cashier: {receipt.header.cashier}</Text>
    {receipt.lineItems.map((line, index) => <View key={index}>
      <Text className="text-foreground">{line.name}</Text>
      {/* Before any discount, then the line's own discounts as sub-rows (TallyUI ADR-063); they add up to the subtotal. */}
      {row(`${line.quantity} × ${money(line.unitPriceMinor)}`, money(line.displayAmountMinor))}
      {line.displayDiscounts.map((discount, i) => <View key={i} className="pl-4">{row(`${discountLabel(
        order.lineItems[index].discounts[i], receipt.currency)} off`, `−${money(discount.amountMinor)}`)}</View>)}
    </View>)}
    {receipt.orderDiscountMinor > 0 ? row('Order discount', `−${money(receipt.orderDiscountMinor)}`) : null}
    {/* order.display's figures (TallyUI ADR-063, ADR 0008), in the cart's order. Exclusive: subtotal − discount + VAT
        = total; inclusive: subtotal − discount = total, and the VAT is "incl.", not added. */}
    {row('Subtotal', money(totals.subtotalMinor))}
    {totals.discountMinor > 0 ? row('Discount', `−${money(totals.discountMinor)}`) : null}
    {vat}
    {row('Total', money(totals.totalMinor), true)}
    {receipt.payments.map((payment, index) => row(payment.method === 'cash' ? 'Cash tendered' : 'Card terminal',
      money(payment.amountMinor) + (payment.reference ? ` · ${payment.reference}` : ''), false, index))}
    {row('Change', money(receipt.changeDueMinor))}
    <View dataSet={{ print: 'hide' }} className="flex-row gap-4">
      <Pressable accessibilityRole="button" onPress={() => { if (typeof window !== 'undefined' && typeof window.print === 'function') window.print(); }} className="rounded-md border border-border bg-card px-4 py-3">
        <Text className="text-center text-foreground">Print receipt</Text>
      </Pressable>
      <Pressable accessibilityRole="button" onPress={newSale} className="rounded-md bg-primary px-4 py-3"><Text className="text-center font-semibold text-primary-foreground">New sale</Text></Pressable>
    </View>
  </View></>;
}
