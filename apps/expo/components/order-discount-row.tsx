import { type JSX } from 'react';
import { View } from 'react-native';
import { discountLabel, IconButton, Text, XIcon } from '@tallyui/components';
import { useFormatMoney } from '@tallyui/core';
import { type useSale } from '@tallyui/pos';

type Sale = ReturnType<typeof useSale>;

/** v2's "Discount (10%) ✕" row in the totals, one per order discount, in place of Cart's chips (orderDiscountChips={false}).
 * The amount is order.display's, as the chip's was: display.orderDiscountMinor for a single discount; with several, a
 * fixed one reads its own label (the chip's text) and a percentage none. ✕ is the chip's removal, sale.removeDiscount. */
export function OrderDiscountRow({ sale }: { sale: Sale }): JSX.Element | null {
  const format = useFormatMoney();
  const { discounts, currency, display } = sale.order;
  if (!discounts.length) return null;
  return <>{discounts.map((discount, index) => {
    const own = discountLabel(discount, currency, format);
    const amount = discounts.length === 1 ? format({ amount: display.orderDiscountMinor, currency }) : discount.type === 'fixed' ? own : null;
    return <View key={discount.id} testID={`order-discount-row-${index}`} className="flex-row items-center justify-between gap-2">
      <Text className="flex-1 text-sm text-muted-foreground">{discount.type === 'percentage' ? `Discount (${own})` : 'Discount'}</Text>
      {amount ? <Text className="text-sm">−{amount}</Text> : null}
      <IconButton size="sm" testID={`order-discount-remove-${index}`} accessibilityLabel={`Remove discount ${own}`}
        onPress={() => sale.removeDiscount(discount.id)}>
        <View className="text-muted-foreground"><XIcon size={16} /></View>
      </IconButton>
    </View>;
  })}</>;
}
