import { Pressable, View } from 'react-native';
import { Text } from '@tallyui/components';

// v2's phone header: an amber dot and the register's state before the avatar (row 17a.2). Plain dot and text, no pill.
export function HeaderRegisterState({ label, onPress }: { label: 'Closed' | 'Counting' | 'Choose register'; onPress: () => void }) {
  return <Pressable testID="header-register-state" accessibilityRole="button"
    accessibilityLabel={label === 'Choose register' ? label : `Register: ${label}`} onPress={onPress}
    className="min-h-11 shrink-0 flex-row pl-3 items-center gap-2">
    <View className="h-2 w-2 rounded-full bg-warning" />
    <Text numberOfLines={1} className="shrink-0 text-sm text-foreground">{label}</Text>
  </Pressable>;
}
