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
  return <View className="gap-3 p-4 bg-card">
    <Text className="text-lg font-semibold text-foreground">{receipt.header.storeName}</Text>
    {receipt.header.storeAddress ? <Text className="text-muted-foreground">{receipt.header.storeAddress}</Text> : null}
    <Text className="text-foreground">Order {receipt.header.orderNumber.slice(-8)}</Text>
    <Text className="text-muted-foreground">{receipt.header.date}</Text>
    <Text className="text-muted-foreground">Cashier: {receipt.header.cashier}</Text>
    <Text className="text-muted-foreground">Register: {receipt.header.register}</Text>
    {receipt.lineItems.map((line, index) => <View key={index}>
      <Text className="text-foreground">{line.name}</Text>
      <Text className="text-foreground">{line.quantity} × {money(line.unitPriceMinor)} · {money(line.lineTotalMinor)}</Text>
    </View>)}
    <Text className="text-foreground">Subtotal: {money(receipt.totals.subtotalMinor)}</Text>
    {receipt.totals.taxLines.map((line, index) => <Text key={index} className="text-foreground">VAT {line.ratePpm / 10000}%: {money(line.amountMinor)}</Text>)}
    <Text className="font-semibold text-foreground">Total: {money(receipt.totals.totalMinor)}</Text>
    {receipt.payments.map((payment, index) => <Text key={index} className="text-foreground">
      {payment.method === 'cash' ? 'Cash tendered' : 'Card terminal'}: {money(payment.amountMinor)}{payment.reference ? ` · ${payment.reference}` : ''}
    </Text>)}
    <Text className="text-foreground">Change: {money(receipt.changeDueMinor)}</Text>
    <View dataSet={{ print: 'hide' }} className="flex-row gap-4">
      <Pressable accessibilityRole="button" onPress={() => { if (typeof window !== 'undefined' && typeof window.print === 'function') window.print(); }} className="rounded-md border border-border bg-card px-4 py-3">
        <Text className="text-center text-foreground">Print receipt</Text>
      </Pressable>
      <Pressable accessibilityRole="button" onPress={newSale} className="rounded-md bg-primary px-4 py-3"><Text className="text-center font-semibold text-primary-foreground">New sale</Text></Pressable>
    </View>
  </View>;
}
