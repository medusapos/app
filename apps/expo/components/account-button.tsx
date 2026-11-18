import { Pressable } from 'react-native';
import { Avatar } from '@tallyui/components';

/** v2's account avatar, the Sale's header button and every area's: it opens the Sale's user sheet. */
export function AccountButton({ displayName, initials, onPress, testID }: {
  displayName: string; initials: string; onPress: () => void; testID: string;
}) {
  return <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={`Account: ${displayName}`}
    onPress={onPress} className="min-h-11 min-w-11 flex-row items-center justify-center">
    {/* At every width, v2's avatar: light initials on a solid primary circle; the signed-in user's name is the
        button's accessible name. */}
    <Avatar testID={`${testID}-avatar`} fallback={initials} tone="primary" size="sm" />
  </Pressable>;
}
