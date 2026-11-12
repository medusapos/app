import { useRef, useState, type JSX } from 'react';
import { Pressable, View } from 'react-native';
import { Button, Input, Text } from '@tallyui/components';
import { formatMoney, type ServerCapabilities } from '@tallyui/core';
import { type Order, type useSale } from '@tallyui/pos';

type Sale = ReturnType<typeof useSale>;

/** Whether the till offers coupons: the same rule useSale applies (capabilities.coupons and order.create v6+). */
export function couponsEnabled(capabilities: ServerCapabilities | undefined): boolean {
  return capabilities?.coupons === true && (capabilities.orderCreate ?? 1) >= 6;
}

/** Σ order.display.coupons[].amountMinor (0 when none): the Cart's couponDiscountMinor. */
export function couponDiscountMinor(order: Order): number {
  return (order.display.coupons ?? []).reduce((sum, coupon) => sum + coupon.amountMinor, 0);
}

export function CouponField({ sale }: { sale: Sale }): JSX.Element {
  const [text, setText] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const inFlight = useRef(false);
  async function apply() {
    if (!text.trim() || inFlight.current) return;
    inFlight.current = true;
    setApplying(true);
    try {
      const refusal = await sale.applyCoupon(text);
      setMessage(refusal);
      if (refusal === null) setText('');
    } finally {
      inFlight.current = false;
      setApplying(false);
    }
  }
  return <View testID="coupon-field" className="gap-2">
    {sale.order.display.coupons?.map(({ code, amountMinor }) => <View key={code} testID={`coupon-row-${code}`} className="flex-row items-center gap-3">
      <Text className="flex-1 text-foreground">Coupon {code.toUpperCase()}</Text>
      <Text className="text-foreground">−{formatMoney({ amount: amountMinor, currency: sale.order.currency })}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={`Remove coupon ${code.toUpperCase()}`}
        onPress={() => setMessage(sale.removeCoupon(code))}
        className="rounded-md border border-border bg-card px-3 py-2 min-h-11 items-center justify-center">
        <Text className="text-foreground">Remove</Text>
      </Pressable>
    </View>)}
    {sale.couponsRepricing ? <Text className="text-muted-foreground">Checking coupon prices…</Text> : null}
    {sale.order.couponPricesStale && !sale.couponsRepricing ? <Button variant="outline" testID="coupon-reprice"
      onPress={() => { void sale.repriceCoupons(); }}><Text>Check coupons again</Text></Button> : null}
    <View className="flex-row items-center gap-2">
      <Input className="flex-1"><Input.Field value={text} onChangeText={(value) => { setText(value); setMessage(null); }}
        accessibilityLabel="Coupon code" placeholder="Coupon code" autoCapitalize="characters" autoComplete="off"
        autoCorrect={false} onSubmitEditing={() => { void apply(); }} /></Input>
      <Button variant="outline" testID="coupon-apply" className="min-h-11" disabled={!text.trim() || applying}
        onPress={() => { void apply(); }}><Text>Apply</Text></Button>
    </View>
    {message !== null ? <Text accessibilityRole="alert" className="text-destructive">{message}</Text> : null}
  </View>;
}
