import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { CartLine, CartLineActions, CartPanel, CartTotal } from '@tallyui/components';
import { formatMoney } from '@tallyui/core';
import { buildReceiptData } from '@tallyui/pos';
import type { useSale } from '../lib/use-sale';
import { DiscountChips, DiscountForm } from './discount-form';

export function Cart({ sale }: { sale: ReturnType<typeof useSale> }) {
  const { order } = sale;
  const money = (amount: number) => ({ amount, currency: order.currency });
  // order.display's figures (TallyUI ADR-063), with its tax split by rate; never app arithmetic (ADR 0008).
  const { totals } = buildReceiptData(order, { storeName: '' });
  const vat = totals.taxLines.map((line) => ({ label: `${totals.taxInclusive ? 'Includes ' : ''}VAT ${line.ratePpm / 10000}%`,
    amount: money(line.amountMinor) }));
  // The open discount form: a line's, or the order's (lineId null).
  const [form, setForm] = useState<{ lineId: string | null } | null>(null);
  const discountForm = (lineId: string | null, title: string) => form?.lineId === lineId
    ? <DiscountForm key={lineId ?? 'order'} title={title} currency={order.currency} onClose={() => setForm(null)}
      onApply={(discount) => sale.applyDiscount(lineId, discount)} /> : null;
  return <CartPanel dataSet={{ print: 'hide' }} items={order.lineItems}
    emptyState={<Text className="text-muted-foreground">Scan or tap a product to start a sale.</Text>}
    renderItem={(line) => <View key={line.id}>
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
    </View>}
    footer={<View className="gap-3 pb-4">
      <DiscountChips discounts={order.discounts} currency={order.currency} onRemove={sale.removeDiscount} prefix="Order discount" />
      {form?.lineId === null ? discountForm(null, 'Order discount') : order.lineItems.length ? <Pressable accessibilityRole="button"
        onPress={() => setForm({ lineId: null })} className="self-start rounded-md border border-border bg-card px-4 py-2 min-h-11 justify-center">
        <Text className="text-foreground">Order discount</Text></Pressable> : null}
      {/* Exclusive: subtotal − discount + VAT = total. Inclusive: subtotal − discount = total, the VAT under it, not added. */}
      <View><CartTotal subtotal={money(totals.subtotalMinor)} discount={money(totals.discountMinor)} total={money(totals.totalMinor)}
        taxLines={totals.taxInclusive ? undefined : vat} />
      {totals.taxInclusive ? vat.map((line) => <View key={line.label} accessibilityLabel={`${line.label}: ${formatMoney(line.amount)}`}
        className="flex-row justify-between px-3 pb-2"><Text className="text-sm text-muted-foreground">{line.label}</Text>
        <Text className="text-sm text-muted-foreground">{formatMoney(line.amount)}</Text></View>) : null}</View>
      {sale.error ? <Text accessibilityRole="alert" className="text-destructive">{sale.error}</Text> : null}
      <Pressable accessibilityRole="button" disabled={!order.lineItems.length} onPress={() => sale.startTender('cash')} className={`rounded-md bg-primary px-4 py-3 ${!order.lineItems.length ? 'opacity-50' : ''}`}>
        <Text className="text-center font-semibold text-primary-foreground">Cash</Text>
      </Pressable>
      <Pressable accessibilityRole="button" disabled={!order.lineItems.length} onPress={() => sale.startTender('external')} className={`rounded-md bg-primary px-4 py-3 ${!order.lineItems.length ? 'opacity-50' : ''}`}>
        <Text className="text-center font-semibold text-primary-foreground">Card terminal</Text>
      </Pressable>
    </View>} />;
}
