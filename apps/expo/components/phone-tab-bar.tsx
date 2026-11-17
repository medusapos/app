// v2's phone tab bar (docs/v2-parity/demo-shots/17-pos-demo-phone.jpg), below 600 px per ADR 0009; an empty cart shows v2's "New" badge.
import type { JSX } from 'react';
import { Pressable, View } from 'react-native';
import { AppText as Text } from './app-text';
import { Path } from 'react-native-svg';
import { Badge, createSvgIcon, InCartBadge, ShoppingCartIcon } from '@tallyui/components';

const GiftIcon = createSvgIcon('GiftIcon', () => <>
  <Path d="M3 8m0 1a1 1 0 0 1 1 -1h16a1 1 0 0 1 1 1v2a1 1 0 0 1 -1 1h-16a1 1 0 0 1 -1 -1z" />
  <Path d="M12 8l0 13" />
  <Path d="M19 12v7a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2v-7" />
  <Path d="M7.5 8a2.5 2.5 0 0 1 0 -5a4.8 8 0 0 1 4.5 5a4.8 8 0 0 1 4.5 -5a2.5 2.5 0 0 1 0 5" />
</>);

export type PhoneTab = 'products' | 'cart';
export function PhoneTabBar({ active, itemCount, onSelect }: {
  active: PhoneTab; itemCount: number; onSelect: (tab: PhoneTab) => void;
}): JSX.Element {
  const productsColor = active === 'products' ? 'text-primary' : 'text-muted-foreground';
  const cartColor = active === 'cart' ? 'text-primary' : 'text-muted-foreground';
  return (
    <View testID="phone-tab-bar" accessibilityRole="tablist" className="flex-row border-t border-border bg-card">
      <Pressable testID="phone-tab-products" accessibilityRole="tab" accessibilityLabel="Products"
        accessibilityState={{ selected: active === 'products' }} aria-selected={active === 'products'} onPress={() => onSelect('products')}
        className="min-h-14 flex-1 items-center justify-center gap-1">
        <View className={productsColor}><GiftIcon size={24} /></View>
        <Text className={`text-sm ${productsColor}`}>Products</Text>
      </Pressable>
      <Pressable testID="phone-tab-cart" accessibilityRole="tab"
        accessibilityLabel={itemCount === 0 ? 'Cart, New' : `Cart, ${itemCount} ${itemCount === 1 ? 'item' : 'items'}`}
        accessibilityState={{ selected: active === 'cart' }} aria-selected={active === 'cart'} onPress={() => onSelect('cart')}
        className="min-h-14 flex-1 items-center justify-center gap-1">
        <View className={`relative ${cartColor}`}>
          <ShoppingCartIcon size={24} />
          <InCartBadge count={itemCount} testID="phone-tab-cart-count" className="absolute -right-4 -top-2" />
          {itemCount === 0 && <Badge label="New" testID="phone-tab-cart-new" className="absolute -right-6 -top-2 px-1.5 py-0" />}
        </View>
        <Text className={`text-sm ${cartColor}`}>Cart</Text>
      </Pressable>
    </View>
  );
}
