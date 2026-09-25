import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { CartLine, CartLineActions, CartTotal } from '@tallyui/components';
import { formatMoney } from '@tallyui/core';
import { buildReceiptData } from '@tallyui/pos';
import type { useSale } from '../lib/use-sale';
import { DiscountChips, DiscountForm } from './discount-form';

export function Cart({ sale }: { sale: ReturnType<typeof useSale> }) {
  const { order } = sale;
  const money = (amount: number) => ({ amount, currency: order.currency });
  const { totals } = buildReceiptData(order, { storeName: '' });
  // The open discount form: a line's, or the order's (lineId null).
  const [form, setForm] = useState<{ lineId: string | null } | null>(null);
  const discountForm = (lineId: string | null, title: string) => form?.lineId === lineId
    ? <DiscountForm key={lineId ?? 'order'} title={title} currency={order.currency} onClose={() => setForm(null)}
      onApply={(discount) => sale.applyDiscount(lineId, discount)} /> : null;
  const pay = `min-h-12 flex-1 justify-center rounded-md bg-primary px-4 py-3 ${!order.lineItems.length ? 'opacity-50' : ''}`;
  // Composed here, not with TallyUI's CartPanel (same classes): its scroll area holds only the lines (ADR 0009).
  return <View dataSet={{ print: 'hide' }} className="flex-1">
    {order.lineItems.length ? <ScrollView testID="cart-scroll" className="flex-1">
      {order.lineItems.map((line) => <View key={line.id}>
        <CartLineActions actions={[{ id: 'discount', label: 'Discount', color: 'text-primary', onPress: () => setForm({ lineId: line.id }) }]}>
          <CartLine name={line.name} quantity={line.quantity} unitPrice={money(line.unitPriceMinor)}
            lineTotal={money(line.netMinor)} />
        </CartLineActions>
        <DiscountChips discounts={line.discounts} currency={order.currency} onRemove={sale.removeDiscount} />
        <View className="flex-row gap-4 px-3 py-2">
          <Pressable accessibilityRole="button" accessibilityLabel={`Decrease ${line.name}`}
            onPress={() => sale.setQuantity(line.id, line.quantity - 1)} className="rounded-md border border-border bg-card px-3 py-2 min-h-11 min-w-11 items-center justify-center"><Text className="text-center text-foreground">−</Text></Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel={`Increase ${line.name}`}
            onPress={() => sale.setQuantity(line.id, line.quantity + 1)} className="rounded-md border border-border bg-card px-3 py-2 min-h-11 min-w-11 items-center justify-center"><Text className="text-center text-foreground">+</Text></Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${line.name}`}
            onPress={() => sale.remove(line.id)} className="rounded-md border border-border bg-card px-3 py-2 min-h-11 min-w-11 items-center justify-center"><Text className="text-center text-foreground">Remove</Text></Pressable>
        </View>
        {discountForm(line.id, `Discount on ${line.name}`)}
      </View>)}
      <View className="gap-3 px-3 py-2">
        <DiscountChips discounts={order.discounts} currency={order.currency} onRemove={sale.removeDiscount} prefix="Order discount" />
        {form?.lineId === null ? discountForm(null, 'Order discount') : <Pressable accessibilityRole="button"
          onPress={() => setForm({ lineId: null })} className="self-start rounded-md border border-border bg-card px-4 py-2 min-h-11 justify-center">
          <Text className="text-foreground">Order discount</Text></Pressable>}
      </View>
    </ScrollView> : <Text className="text-muted-foreground">Scan or tap a product to start a sale.</Text>}
    <View testID="cart-footer" className="gap-3 border-t border-border px-3 pt-2 pb-6">
      {/* Information only: the lines and the subtotal are already after every discount, so the totals never subtract it. */}
      {order.discountMinor > 0 ? <Text className="px-3 text-muted-foreground">Includes discounts of {formatMoney(money(order.discountMinor))}</Text> : null}
      <CartTotal subtotal={money(totals.subtotalMinor)} total={money(totals.totalMinor)}
        taxLines={totals.taxLines.map((line) => ({ label: `VAT ${line.ratePpm / 10000}%`, amount: money(line.amountMinor) }))} />
      {sale.error ? <Text accessibilityRole="alert" className="text-destructive">{sale.error}</Text> : null}
      <View className="flex-row gap-3">
        <Pressable accessibilityRole="button" disabled={!order.lineItems.length} onPress={() => sale.startTender('cash')} className={pay}>
          <Text className="text-center font-semibold text-primary-foreground">Cash</Text>
        </Pressable>
        <Pressable accessibilityRole="button" disabled={!order.lineItems.length} onPress={() => sale.startTender('external')} className={pay}>
          <Text className="text-center font-semibold text-primary-foreground">Card terminal</Text>
        </Pressable>
      </View>
    </View>
  </View>;
}
