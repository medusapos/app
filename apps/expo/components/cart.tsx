import { Pressable, Text, View } from 'react-native';
import { CartLine, CartPanel, CartTotal } from '@tallyui/components';
import { buildReceiptData } from '@tallyui/pos';
import type { useSale } from '../lib/use-sale';

export function Cart({ sale }: { sale: ReturnType<typeof useSale> }) {
  const { order } = sale;
  const money = (amount: number) => ({ amount, currency: order.currency });
  const { totals } = buildReceiptData(order, { storeName: '' });
  return <CartPanel dataSet={{ print: 'hide' }} items={order.lineItems}
    emptyState={<Text className="text-muted-foreground">Scan or tap a product to start a sale.</Text>}
    renderItem={(line) => <View key={line.id}>
      <CartLine name={line.name} quantity={line.quantity} unitPrice={money(line.unitPriceMinor)}
        lineTotal={money(line.netMinor)} />
      <View className="flex-row gap-4 px-3 py-2">
        <Pressable accessibilityRole="button" accessibilityLabel={`Decrease ${line.name}`}
          onPress={() => sale.setQuantity(line.id, line.quantity - 1)} className="rounded-md border border-border bg-card px-3 py-2"><Text className="text-center text-foreground">−</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={`Increase ${line.name}`}
          onPress={() => sale.setQuantity(line.id, line.quantity + 1)} className="rounded-md border border-border bg-card px-3 py-2"><Text className="text-center text-foreground">+</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${line.name}`}
          onPress={() => sale.remove(line.id)} className="rounded-md border border-border bg-card px-3 py-2"><Text className="text-center text-foreground">Remove</Text></Pressable>
      </View>
    </View>}
    footer={<View className="gap-3">
      <CartTotal subtotal={money(totals.subtotalMinor)} total={money(totals.totalMinor)}
        taxLines={totals.taxLines.map((line) => ({ label: `VAT ${line.ratePpm / 10000}%`, amount: money(line.amountMinor) }))} />
      {sale.error ? <Text accessibilityRole="alert" className="text-destructive">{sale.error}</Text> : null}
      <Pressable accessibilityRole="button" disabled={!order.lineItems.length} onPress={() => sale.startTender('cash')} className={`rounded-md bg-primary px-4 py-3 ${!order.lineItems.length ? 'opacity-50' : ''}`}>
        <Text className="text-center font-semibold text-primary-foreground">Cash</Text>
      </Pressable>
      <Pressable accessibilityRole="button" disabled={!order.lineItems.length} onPress={() => sale.startTender('external')} className={`rounded-md bg-primary px-4 py-3 ${!order.lineItems.length ? 'opacity-50' : ''}`}>
        <Text className="text-center font-semibold text-primary-foreground">Card terminal</Text>
      </Pressable>
    </View>} />;
}
