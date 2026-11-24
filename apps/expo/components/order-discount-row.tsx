import { type JSX } from 'react';
import { View } from 'react-native';
import { discountLabel, IconButton, Text, XIcon } from '@tallyui/components';
import { useFormatMoney } from '@tallyui/core';
import { type useSale } from '@tallyui/pos';

type Sale = ReturnType<typeof useSale>;

/** The amount the row shows, so Cart's Discount row leaves it out. */
export function orderDiscountInRowMinor(order: Sale['order']): number {
  return order.discounts.length === 1 ? order.display.orderDiscountMinor : 0;
}

/** v2's "Discount (10%) ✕" row in the totals, one per order discount, in place of Cart's chips (orderDiscountChips={false}).
 * A single discount shows display.orderDiscountMinor; with several, each shows only its own label.
 * ✕ is the chip's removal, sale.removeDiscount. */
export function OrderDiscountRow({ sale }: { sale: Sale }): JSX.Element | null {
  const format = useFormatMoney();
  const { discounts, currency, display } = sale.order;
  if (!discounts.length) return null;
  return <>{discounts.map((discount, index) => {
    const own = discountLabel(discount, currency, format);
    const amount = discounts.length === 1 ? format({ amount: display.orderDiscountMinor, currency }) : null;
    return <View key={discount.id} testID={`order-discount-row-${index}`} className="flex-row items-center justify-between gap-2">
      <Text className="flex-1 text-sm text-muted-foreground">{discount.type === 'percentage' || discounts.length > 1 ? `Discount (${own})` : 'Discount'}</Text>
      {amount ? <Text className="text-sm">−{amount}</Text> : null}
      <IconButton size="sm" testID={`order-discount-remove-${index}`} accessibilityLabel={`Remove discount ${own}`}
        onPress={() => sale.removeDiscount(discount.id)}>
        <View className="text-muted-foreground"><XIcon size={16} /></View>
      </IconButton>
    </View>;
  })}</>;
}
