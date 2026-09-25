import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { CartLine, CartLineActions, CartPanel, CartTotal } from '@tallyui/components';
import { buildReceiptData } from '@tallyui/pos';
import type { useSale } from '../lib/use-sale';
import { DiscountChips, DiscountForm } from './discount-form';

export function Cart({ sale }: { sale: ReturnType<typeof useSale> }) {
  const { order } = sale;
  const money = (amount: number) => ({ amount, currency: order.currency });
  // order.display's figures (TallyUI ADR-063), with its tax split by rate; never app arithmetic (ADR 0008).
  const { totals } = buildReceiptData(order, { storeName: '' });
  const vat = totals.taxLines.map((line) => ({ label: `VAT ${line.ratePpm / 10000}%`, amount: money(line.amountMinor) }));
  // Each line before its discounts, with its own discounts' amounts. The order discounts are one figure: a single
  // order discount's chip carries it; several keep their own labels, as no single one has a display amount.
  const display = (lineId: string) => order.display.lines.find((line) => line.lineId === lineId)!;
  const orderAmounts = order.discounts.length === 1
    ? [{ discountId: order.discounts[0].id, amountMinor: order.display.orderDiscountMinor }] : [];
  // The open discount form: a line's, or the order's (lineId null).
  const [form, setForm] = useState<{ lineId: string | null } | null>(null);
  const discountForm = (lineId: string | null, title: string) => form?.lineId === lineId
    ? <DiscountForm key={lineId ?? 'order'} title={title} currency={order.currency} onClose={() => setForm(null)}
      onApply={(discount) => sale.applyDiscount(lineId, discount)} /> : null;
  const pay = `min-h-12 flex-1 justify-center rounded-md bg-primary px-4 py-3 ${!order.lineItems.length ? 'opacity-50' : ''}`;
  const renderItem = (line: typeof order.lineItems[number]) => <>
    <CartLineActions actions={[{ id: 'discount', label: 'Discount', color: 'text-primary', onPress: () => setForm({ lineId: line.id }) }]}>
      <CartLine name={line.name} quantity={line.quantity} unitPrice={money(line.unitPriceMinor)}
        lineTotal={money(display(line.id).amountMinor)} />
    </CartLineActions>
    <DiscountChips discounts={line.discounts} amounts={display(line.id).discounts} currency={order.currency} onRemove={sale.removeDiscount} />
    <View className="flex-row gap-4 px-3 py-2">
      <Pressable accessibilityRole="button" accessibilityLabel={`Decrease ${line.name}`}
        onPress={() => sale.setQuantity(line.id, line.quantity - 1)} className="rounded-md border border-border bg-card px-3 py-2 min-h-11 min-w-11 items-center justify-center"><Text className="text-center text-foreground">−</Text></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={`Increase ${line.name}`}
        onPress={() => sale.setQuantity(line.id, line.quantity + 1)} className="rounded-md border border-border bg-card px-3 py-2 min-h-11 min-w-11 items-center justify-center"><Text className="text-center text-foreground">+</Text></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${line.name}`}
        onPress={() => sale.remove(line.id)} className="rounded-md border border-border bg-card px-3 py-2 min-h-11 min-w-11 items-center justify-center"><Text className="text-center text-foreground">Remove</Text></Pressable>
    </View>
    {discountForm(line.id, `Discount on ${line.name}`)}
  </>;
  return <CartPanel dataSet={{ print: 'hide' }} items={order.lineItems} renderItem={renderItem}
    emptyState={<Text className="text-muted-foreground">Scan or tap a product to start a sale.</Text>}
    afterItems={order.lineItems.length ? <View className="gap-3 px-3 py-2">
      <DiscountChips discounts={order.discounts} amounts={orderAmounts} currency={order.currency} onRemove={sale.removeDiscount}
        prefix="Order discount" />
      {form?.lineId === null ? discountForm(null, 'Order discount') : <Pressable accessibilityRole="button"
        onPress={() => setForm({ lineId: null })} className="self-start rounded-md border border-border bg-card px-4 py-2 min-h-11 justify-center">
        <Text className="text-foreground">Order discount</Text></Pressable>}
    </View> : undefined}
    footer={<View testID="cart-footer" className="gap-3 pb-4">
      {/* Exclusive: subtotal − discount + VAT = total. Inclusive: subtotal − discount = total, the VAT "incl.", not added. */}
      <CartTotal subtotal={money(totals.subtotalMinor)} discount={money(totals.discountMinor)} total={money(totals.totalMinor)}
        taxLines={vat} taxInclusive={totals.taxInclusive} />
      {sale.error ? <Text accessibilityRole="alert" className="text-destructive">{sale.error}</Text> : null}
      <View className="flex-row gap-3">
        <Pressable accessibilityRole="button" disabled={!order.lineItems.length} onPress={() => sale.startTender('cash')} className={pay}>
          <Text className="text-center font-semibold text-primary-foreground">Cash</Text>
        </Pressable>
        <Pressable accessibilityRole="button" disabled={!order.lineItems.length} onPress={() => sale.startTender('external')} className={pay}>
          <Text className="text-center font-semibold text-primary-foreground">Card terminal</Text>
        </Pressable>
      </View>
    </View>} />;
}
