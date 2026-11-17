import { Pressable, Text, View } from 'react-native';
import { Avatar, avatarInitials } from '@tallyui/components';

/** v2's cart customer chip (DEMO-PARITY row 04a.2): a muted label, then the customer's avatar and name. */
export function CustomerChip({ name, onPress }: { name: string | null | undefined; onPress: () => void }) {
  const shown = name || 'Guest';
  return <View className="min-w-0 shrink flex-row items-center gap-2">
    <Text className="text-muted-foreground">Customer</Text>
    <Pressable testID="customer-chip" accessibilityRole="button" accessibilityLabel={`Customer: ${shown}`} onPress={onPress}
      className="min-h-11 min-w-0 shrink flex-row items-center gap-2 rounded-lg bg-muted px-2">
      {name ? <Avatar aria-hidden size="sm" tone="primary" fallback={avatarInitials(name)} />
        : <Avatar aria-hidden size="sm" tone="muted" fallback="" className="border border-border" />}
      <Text numberOfLines={1} className="shrink text-foreground">{shown}</Text>
    </Pressable>
  </View>;
}
