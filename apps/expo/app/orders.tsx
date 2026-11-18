import { useContext, useMemo, useState } from 'react';
import { View } from 'react-native';
import { Redirect, Stack } from 'expo-router';
import { OrderFilterBar, OrdersList, SearchInput } from '@tallyui/components';
import type { OrderFilterValue } from '@tallyui/pos';
import { FrameMenuButton, useFrameMenu } from '../components/app-frame';
import { OrderDetailSheet } from '../components/order-detail-sheet';
import { StripHeightContext } from '../components/store-refused';
import { useOutboxContext } from '../lib/outbox-context';
import { useSession } from '../lib/session-context';
import { formatDate } from '../lib/format-date';
import { filterOrders, orderFilterOptions, ORDERS_SCREEN_FILTER_FIELDS } from '../lib/order-filters';

export default function OrdersScreen() {
  const { session } = useSession();
  const { recent, requeue, flush } = useOutboxContext();
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<OrderFilterValue>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const options = useMemo(() => orderFilterOptions(recent), [recent]);
  const orders = useMemo(() => filterOrders(recent, search, filters, 'device'), [recent, search, filters]);
  // v2's Orders has no title bar on a wide window; a phone keeps the header for the drawer's Menu.
  const openMenu = useFrameMenu();
  // Without a header the sign-in / refused strip lies over the top of the screen (as on the Sale screen).
  const topInset = useContext(StripHeightContext);
  if (!session) return <Redirect href="/login" />;
  return <View className="flex-1 bg-background" role="main" aria-label="Orders">
    <Stack.Screen options={{ title: 'Orders', headerShown: !!openMenu, headerLeft: () => <FrameMenuButton /> }} />
    <View className="flex-row items-center gap-2 px-4 pb-2" style={{ paddingTop: 16 + topInset }}>
      <SearchInput className="flex-1" value={search} onChangeText={setSearch} placeholder="Search Orders"
        accessibilityLabel="Search Orders" testID="orders-search" />
    </View>
    <View className="px-4 pb-2">
      <OrderFilterBar value={filters} onChange={setFilters} fields={ORDERS_SCREEN_FILTER_FIELDS}
        options={options} timezone="device" testID="orders-filter-bar" />
    </View>
    <OrdersList orders={orders} onRetry={requeue} formatDate={formatDate}
      onOpen={(row) => { if ('lines' in row) setOpenId(row.id); }} />
    {/* Looked up in `recent`, not the filtered list: the sheet shows live sync status and survives a search. */}
    <OrderDetailSheet order={recent.find((order) => order.id === openId) ?? null} onClose={() => setOpenId(null)}
      formatDate={formatDate} onRetry={requeue} onFlush={flush} />
  </View>;
}
