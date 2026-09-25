import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { DiscountBadge } from '@tallyui/components';
import { formatMoney, minorUnitDigits, moneyFromDecimalString } from '@tallyui/core';
import type { AppliedDiscount, Discount } from '@tallyui/pos';

/** The cashier's entry as a TallyUI Discount (a percent, or integer minor units), or the inline error to show. */
export function parseDiscount(type: Discount['type'], text: string, currency: string): Discount | string {
  // A comma-locale keypad (inputMode="decimal") types "1,50": a single comma is the decimal separator.
  const raw = text.trim();
  const trimmed = raw.split(',').length === 2 ? raw.replace(',', '.') : raw;
  if (!trimmed) return 'Enter a discount.';
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return 'Enter a number.';
  const value = Number(trimmed);
  if (value <= 0) return 'Enter a discount above 0.';
  if (type === 'percentage') return value > 100 ? 'A percentage can be at most 100.' : { type, value };
  const digits = minorUnitDigits(currency);
  if ((trimmed.split('.')[1]?.length ?? 0) > digits) return digits ? `Use at most ${digits} decimal places.` : 'Use a whole amount.';
  const money = moneyFromDecimalString(trimmed, currency);
  return money ? { type, value: money.amount } : 'Enter a number.';
}

/** "10%", or a fixed discount's amount as it actually comes off (amountMinor), never the amount requested. */
export const discountLabel = (discount: AppliedDiscount, currency: string) => discount.type === 'percentage'
  ? `${discount.value}%` : formatMoney({ amount: discount.amountMinor, currency }) ?? String(discount.amountMinor);

const button = 'rounded-md border border-border px-3 py-2 min-h-11 items-center justify-center';

/** `onApply` returns a refusal to show inline (the capability gate), or null once applied. */
export function DiscountForm({ title, currency, onApply, onClose }: {
  title: string; currency: string; onApply: (discount: Discount) => string | null; onClose: () => void;
}) {
  const [type, setType] = useState<Discount['type']>('percentage');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  function apply() {
    const parsed = parseDiscount(type, text, currency);
    const refused = typeof parsed === 'string' ? parsed : onApply(parsed);
    setError(refused);
    if (refused === null) onClose();
  }
  return <View role="group" accessibilityLabel={title} className="gap-2 px-3 py-2">
    <Text className="font-semibold text-foreground">{title}</Text>
    <View className="flex-row gap-2">
      {(['percentage', 'fixed'] as const).map((option) => <Pressable key={option} accessibilityRole="button"
        accessibilityState={{ selected: type === option }} onPress={() => setType(option)}
        className={`${button} ${type === option ? 'bg-primary' : 'bg-card'}`}>
        <Text className={type === option ? 'text-primary-foreground' : 'text-foreground'}>{option === 'percentage' ? 'Percent' : 'Amount'}</Text>
      </Pressable>)}
      <TextInput accessibilityLabel="Discount value" value={text} onChangeText={setText} onSubmitEditing={apply}
        inputMode="decimal" placeholder={type === 'percentage' ? '%' : currency}
        className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 text-foreground" />
    </View>
    {error ? <Text accessibilityRole="alert" className="text-destructive">{error}</Text> : null}
    <View className="flex-row gap-2">
      <Pressable accessibilityRole="button" onPress={apply} className={`${button} bg-primary`}>
        <Text className="font-semibold text-primary-foreground">Apply</Text></Pressable>
      <Pressable accessibilityRole="button" onPress={onClose} className={`${button} bg-card`}>
        <Text className="text-foreground">Cancel</Text></Pressable>
    </View>
  </View>;
}

/** Applied discounts as badges; pressing one removes it through TallyUI's builder. */
/** `prefix` names a chip that would otherwise read like a fee, e.g. "Order discount −€0.50". */
export function DiscountChips({ discounts, currency, onRemove, prefix }: {
  discounts: AppliedDiscount[]; currency: string; onRemove: (id: string) => void; prefix?: string;
}) {
  if (!discounts.length) return null;
  return <View className="flex-row flex-wrap gap-2 px-3">
    {discounts.map((discount) => {
      const label = discountLabel(discount, currency);
      return <Pressable key={discount.id} accessibilityRole="button" accessibilityLabel={`Remove discount ${label}`}
        onPress={() => onRemove(discount.id)} className="min-h-11 flex-row items-center gap-1">
        <DiscountBadge label={prefix ? `${prefix} −${label}` : label} className="self-center" /><Text className="text-muted-foreground">✕</Text>
      </Pressable>;
    })}
  </View>;
}
