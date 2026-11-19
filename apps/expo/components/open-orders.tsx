import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import { IconButton, OpenSaleTabs, XIcon } from '@tallyui/components';
import { formatMoney } from '@tallyui/core';
import type { OpenSale } from '@tallyui/pos';
import { AppText as Text } from './app-text';

/** Whether the open-sale tabs overflow their strip, read from OpenSaleTabs' `[role="tablist"]` scroller on the web. */
export function useTabsOverflow(): { ref: RefObject<View | null>; overflowing: boolean; onLayout: () => void } {
  const ref = useRef<View | null>(null);
  const [overflowing, setOverflowing] = useState(false);
  const last = useRef(false);
  // Off the web: OpenSaleTabs exposes no overflow, and native swipes the strip, so no count shows.
  const tablist = () => Platform.OS === 'web'
    ? (ref.current as unknown as HTMLElement | null)?.querySelector<HTMLElement>('[role="tablist"]') ?? null : null;
  const measure = useCallback(() => {
    const el = tablist();
    const next = el ? el.scrollWidth > el.clientWidth + 1 : false;
    if (next !== last.current) { last.current = next; setOverflowing(next); }
  }, []);
  useLayoutEffect(() => { measure(); });
  useEffect(() => {
    const el = tablist();
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, [measure]);
  return { ref, overflowing, onLayout: measure };
}

/** The open-sale strip: v2's count of open orders at its start, only while the tabs overflow, then the tabs. */
export function OpenOrdersStrip({ sales, currency, listOpen, onListOpenChange, onSelect, onNew }: {
  sales: OpenSale[]; currency: string; listOpen: boolean; onListOpenChange: (open: boolean) => void;
  onSelect: (id: string) => void; onNew: () => void;
}) {
  const { ref, overflowing, onLayout } = useTabsOverflow();
  useEffect(() => { if (!overflowing && listOpen) onListOpenChange(false); }, [overflowing, listOpen, onListOpenChange]);
  return <View className="flex-row items-stretch">
    {overflowing && <Pressable testID="open-orders-count" accessibilityRole="button"
      accessibilityLabel={`Open orders (${sales.length})`} accessibilityState={{ expanded: listOpen }}
      onPress={() => onListOpenChange(!listOpen)} className="h-14 justify-center border-t border-r border-border bg-card px-3">
      <Text className="font-medium text-foreground tabular-nums">{`${sales.length} ${listOpen ? '▾' : '▴'}`}</Text>
    </Pressable>}
    <View ref={ref} onLayout={onLayout} className="min-w-0 flex-1">
      <OpenSaleTabs sales={sales} currency={currency} onSelect={onSelect} onNew={onNew} />
    </View>
  </View>;
}

/** v2's Open orders list: one row per open sale, oldest first, the one on screen highlighted; a tap switches to it. */
export function OpenOrdersList({ sales, currency, onSelect, onClose }: {
  sales: OpenSale[]; currency: string; onSelect: (id: string) => void; onClose: () => void;
}) {
  return <View testID="open-orders-list" className="flex-1">
    <View className="flex-row items-center justify-between border-b border-border pl-3">
      <Text className="font-semibold text-foreground">Open orders</Text>
      <IconButton testID="open-orders-close" accessibilityLabel="Close" className="h-11 w-11" onPress={onClose}>
        <View className="text-foreground"><XIcon size={24} /></View>
      </IconButton>
    </View>
    <ScrollView>
      {sales.map((sale) => <Pressable key={sale.id} testID={`open-orders-row-${sale.id}`} accessibilityRole="button"
        accessibilityState={{ selected: sale.current }} aria-selected={sale.current} onPress={() => onSelect(sale.id)}
        className={`border-b border-border px-3 py-2${sale.current ? ' bg-muted border-l-2 border-l-primary' : ''}`}>
        <View className="flex-row items-center gap-3">
          <View className="min-w-0 flex-1">
            <Text testID={`open-orders-row-${sale.id}-who`} numberOfLines={1} className="font-medium text-foreground">
              {sale.customerName ?? 'Guest'}
            </Text>
            <Text testID={`open-orders-row-${sale.id}-items`} numberOfLines={1} className="text-sm text-muted-foreground">
              {sale.itemCount >= 3 ? `${sale.itemCount} items · ${sale.firstItem}` : sale.firstItem ?? ''}
            </Text>
          </View>
          <Text testID={`open-orders-row-${sale.id}-total`} className="font-semibold text-foreground tabular-nums">
            {formatMoney({ amount: sale.totalMinor, currency })}
          </Text>
        </View>
      </Pressable>)}
    </ScrollView>
  </View>;
}
