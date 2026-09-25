import { Pressable, Text } from 'react-native';
import { formatMoney } from '@tallyui/core';
import { buildReceiptData } from '@tallyui/pos';
import type { useSale } from '../lib/use-sale';

/** Phone mode's cart summary (ADR 0009): the whole bar is one button; the total is the cart's own Total row. */
export function CartBar({ sale, onOpen }: { sale: ReturnType<typeof useSale>; onOpen: () => void }) {
  const { order } = sale;
  const count = order.lineItems.reduce((sum, line) => sum + line.quantity, 0);
  const total = formatMoney({ amount: buildReceiptData(order, { storeName: '' }).totals.totalMinor, currency: order.currency });
  const items = `${count} ${count === 1 ? 'item' : 'items'}`;
  return <Pressable accessibilityRole="button" accessibilityLabel={count ? `Open cart, ${items}, ${total}` : 'Cart is empty'}
    disabled={!count} onPress={onOpen}
    className={`min-h-14 mx-3 mb-3 flex-row items-center justify-between rounded-md bg-primary px-4 py-3 ${count ? '' : 'opacity-50'}`}>
    <Text className="font-bold text-primary-foreground">{count ? `Cart · ${items}` : 'Cart is empty'}</Text>
    {count ? <Text className="font-bold text-primary-foreground">{total} ›</Text> : null}
  </Pressable>;
}
