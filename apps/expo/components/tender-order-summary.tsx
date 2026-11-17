import { ScrollView, Text, View } from 'react-native';
import { CartColumnHeads, CartLine, CartTotal } from '@tallyui/components';
import { formatMoney } from '@tallyui/core';
import { buildReceiptData, type useSale } from '@tallyui/pos';

export function TenderOrderSummary({ order, taxLabel }: {
  order: ReturnType<typeof useSale>['order']; taxLabel: (ratePpm: number) => string;
}) {
  const money = (amount: number) => ({ amount, currency: order.currency });
  const { totals } = buildReceiptData(order, { storeName: '' });
  const taxRows = totals.taxLines.map((line) => ({ label: taxLabel(line.ratePpm), amount: money(line.amountMinor) }));
  return <View testID="tender-order-summary" className="flex-1 min-h-0">
    <Text testID="tender-summary-customer" className="border-b border-border px-3 py-3 text-foreground">
      Customer: {order.customer?.name ?? 'Guest'}
    </Text>
    <CartColumnHeads />
    <ScrollView className="flex-1">
      {order.lineItems.map((line) => <View key={line.id} testID={`tender-summary-line-${line.id}`}>
        <CartLine name={line.name} attributes={line.attributes} quantity={line.quantity}
          unitPrice={money(line.unitPriceMinor)}
          regularUnitPrice={line.regularUnitPriceMinor === undefined ? undefined : money(line.regularUnitPriceMinor)}
          lineTotal={money(order.display.lines.find((row) => row.lineId === line.id)!.amountMinor)}
          sku={line.sku} imageUrl={line.imageUrl} />
      </View>)}
      {(['fees', 'shipping'] as const).map((kind) => order[kind]?.map((charge, index) =>
        <View key={charge.id} testID={`tender-summary-${kind === 'fees' ? 'fee' : 'shipping'}-${index}`}
          className="flex-row items-center gap-3 px-3 py-2">
          <Text className="flex-1 text-foreground">{charge.name}</Text>
          <Text className="text-foreground">{formatMoney(money(order.display[kind]!.find((row) => row.id === charge.id)!.amountMinor))}</Text>
        </View>))}
    </ScrollView>
    <View testID="tender-summary-totals">
      <CartTotal subtotal={money(totals.subtotalMinor)} total={money(totals.totalMinor)}
        discount={money(totals.discountMinor)} taxLines={taxRows} taxInclusive={totals.taxInclusive} showTotal />
    </View>
  </View>;
}
