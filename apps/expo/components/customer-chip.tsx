import { Pressable, Text, View } from 'react-native';
import { Path } from 'react-native-svg';
import { Avatar, avatarInitials, createSvgIcon } from '@tallyui/components';

// v2's chip address glyph, tabler's `map-pin`.
const MapPinIcon = createSvgIcon('MapPinIcon', () => <><Path d="M9 11a3 3 0 1 0 6 0a3 3 0 0 0 -6 0" />
  <Path d="M17.657 16.657l-4.243 4.243a2 2 0 0 1 -2.827 0l-4.244 -4.243a8 8 0 1 1 11.314 0z" /></>);

/** v2's cart customer chip (DEMO-PARITY row 04a.2): a muted label, then the customer's avatar and name.
 * With `onAddress` (a real customer), a divider and v2's map-pin button that edits their address close the chip. */
export function CustomerChip({ name, onPress, onAddress }: { name: string | null | undefined; onPress: () => void; onAddress?: () => void }) {
  const shown = name || 'Guest';
  return <View className="min-w-0 shrink flex-row items-center gap-2">
    <Text className="text-muted-foreground">Customer</Text>
    <View testID="customer-chip-row" className="min-h-11 min-w-0 shrink flex-row items-center gap-1.5 rounded-full border border-border bg-card px-3">
      <Pressable testID="customer-chip" accessibilityRole="button" accessibilityLabel={`Customer: ${shown}`} onPress={onPress}
        className="min-h-11 min-w-0 shrink flex-row items-center gap-2">
        {name ? <Avatar aria-hidden size="sm" tone="primary" fallback={avatarInitials(name)} />
          : <Avatar aria-hidden size="sm" tone="muted" fallback="" className="border border-border" />}
        <Text numberOfLines={1} className="shrink text-sm text-foreground">{shown}</Text>
      </Pressable>
      {onAddress && <>
        <View className="h-5 w-px bg-border" />
        <Pressable testID="customer-address" accessibilityRole="button" accessibilityLabel="Edit customer address"
          onPress={onAddress} className="min-h-11 items-center justify-center pl-1">
          <View className="text-muted-foreground"><MapPinIcon /></View>
        </Pressable>
      </>}
    </View>
  </View>;
}
