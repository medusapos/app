import { Pressable, Text, View } from 'react-native';
import { CartLine, CartPanel, CartTotal } from '@tallyui/components';
import { buildReceiptData } from '@tallyui/pos';
import type { useSale } from '../lib/use-sale';

export function Cart({ sale }: { sale: ReturnType<typeof useSale> }) {
  const { order } = sale;
  const money = (amount: number) => ({ amount, currency: order.currency });
  const { totals } = buildReceiptData(order, { storeName: '' });
  return <CartPanel dataSet={{ print: 'hide' }} items={order.lineItems}
    emptyState={<Text>Scan or tap a product to start a sale.</Text>}
    renderItem={(line) => <View key={line.id}>
      <CartLine name={line.name} quantity={line.quantity} unitPrice={money(line.unitPriceMinor)}
        lineTotal={money(line.netMinor)} />
      <View className="flex-row gap-4 px-3 py-2">
        <Pressable accessibilityRole="button" accessibilityLabel={`Decrease ${line.name}`}
          onPress={() => sale.setQuantity(line.id, line.quantity - 1)}><Text>−</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={`Increase ${line.name}`}
          onPress={() => sale.setQuantity(line.id, line.quantity + 1)}><Text>+</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${line.name}`}
          onPress={() => sale.remove(line.id)}><Text>Remove</Text></Pressable>
      </View>
    </View>}
    footer={<View className="gap-3">
      <CartTotal subtotal={money(totals.subtotalMinor)} total={money(totals.totalMinor)}
        taxLines={totals.taxLines.map((line) => ({ label: `VAT ${line.ratePpm / 10000}%`, amount: money(line.amountMinor) }))} />
      {sale.error ? <Text accessibilityRole="alert">{sale.error}</Text> : null}
      <Pressable accessibilityRole="button" disabled={!order.lineItems.length} onPress={() => sale.startTender('cash')}>
        <Text>Cash</Text>
      </Pressable>
      <Pressable accessibilityRole="button" disabled={!order.lineItems.length} onPress={() => sale.startTender('external')}>
        <Text>Card terminal</Text>
      </Pressable>
    </View>} />;
}
