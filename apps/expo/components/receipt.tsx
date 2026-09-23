import { useEffect } from 'react';
import { Pressable, Text, View } from 'react-native';
import { formatMoney } from '@tallyui/core';
import { buildReceiptData, type Order } from '@tallyui/pos';
import type { StoreSettings } from '../lib/store-settings';
import { injectPrintStyle } from './print-style';

export function Receipt({ order, settings, cashier, registerId, newSale }: {
  order: Order; settings: StoreSettings; cashier: string; registerId: string; newSale: () => void;
}) {
  useEffect(injectPrintStyle, []);
  const receipt = buildReceiptData(order, {
    storeName: settings.storeName, storeAddress: settings.location.addressLine, cashier, register: registerId,
  });
  const money = (amount: number) => formatMoney({ amount, currency: receipt.currency });
  return <View className="gap-3 p-4">
    <Text>{receipt.header.storeName}</Text>
    {receipt.header.storeAddress ? <Text>{receipt.header.storeAddress}</Text> : null}
    <Text>Order {receipt.header.orderNumber.slice(-8)}</Text>
    <Text>{receipt.header.date}</Text>
    <Text>Cashier: {receipt.header.cashier}</Text>
    <Text>Register: {receipt.header.register}</Text>
    {receipt.lineItems.map((line, index) => <View key={index}>
      <Text>{line.name}</Text>
      <Text>{line.quantity} × {money(line.unitPriceMinor)} · {money(line.lineTotalMinor)}</Text>
    </View>)}
    <Text>Subtotal: {money(receipt.totals.subtotalMinor)}</Text>
    {receipt.totals.taxLines.map((line, index) => <Text key={index}>VAT {line.ratePpm / 10000}%: {money(line.amountMinor)}</Text>)}
    <Text>Total: {money(receipt.totals.totalMinor)}</Text>
    {receipt.payments.map((payment, index) => <Text key={index}>
      {payment.method === 'cash' ? 'Cash tendered' : 'Card terminal'}: {money(payment.amountMinor)}{payment.reference ? ` · ${payment.reference}` : ''}
    </Text>)}
    <Text>Change: {money(receipt.changeDueMinor)}</Text>
    <View dataSet={{ print: 'hide' }} className="flex-row gap-4">
      <Pressable accessibilityRole="button" onPress={() => { if (typeof window !== 'undefined' && typeof window.print === 'function') window.print(); }}>
        <Text>Print receipt</Text>
      </Pressable>
      <Pressable accessibilityRole="button" onPress={newSale}><Text>New sale</Text></Pressable>
    </View>
  </View>;
}
