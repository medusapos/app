// v2's price-check/counting banner sits above Catalogue because it has no slot under the filter chips.
// Selling itself is gated at Checkout by useGatedSale.
import type { JSX } from 'react';
import { Text, View } from 'react-native';
import { Path, Rect } from 'react-native-svg';
import { createSvgIcon } from '@tallyui/components';
import { useRegister } from '../lib/register-context';

export const PRICE_CHECK_ONLY = 'Price check only until the register is open.';
export const COUNTING_DRAWER = 'Counting the drawer. Items can be added after the count.';

const LockIcon = createSvgIcon('LockIcon', () => <>
  <Rect x={5} y={11} width={14} height={10} rx={2} />
  <Path d="M8 11V7a4 4 0 0 1 8 0v4" />
</>);

export function PriceCheckBanner(): JSX.Element | null {
  const { register, boundRegisterId } = useRegister();
  const counting = register.session?.status === 'counting' || register.closing;
  if (!register.enabled || boundRegisterId === undefined || (register.session?.status === 'open' && !counting)) return null;

  return <View testID="price-check-banner" dataSet={{ print: 'hide' }}
    className="flex-row items-center gap-2 border-b border-border bg-muted px-3 py-2">
    <LockIcon size={16} />
    <Text className="text-sm text-muted-foreground">{counting ? COUNTING_DRAWER : PRICE_CHECK_ONLY}</Text>
  </View>;
}
