import { useContext, useMemo, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { Redirect, Stack } from 'expo-router';
import { OrderFilterBar, SearchInput } from '@tallyui/components';
import { needsAttention, type OrderFilterValue } from '@tallyui/pos';
import { AreaAccountButton, FrameMenuButton, useFrameMenu } from '../components/app-frame';
import { OrderDetailSheet } from '../components/order-detail-sheet';
import { OrdersTable } from '../components/orders-table';
import { StripHeightContext } from '../components/store-refused';
import { useOutboxContext } from '../lib/outbox-context';
import { useSession } from '../lib/session-context';
import { formatDate } from '../lib/format-date';
import { filterOrders, orderFilterOptions, ORDERS_SCREEN_FILTER_FIELDS } from '../lib/order-filters';

export default function OrdersScreen() {
  const { session } = useSession();
  const { recent, requeue, flush, state } = useOutboxContext();
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<OrderFilterValue>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const options = useMemo(() => orderFilterOptions(recent), [recent]);
  const orders = useMemo(() => filterOrders(recent, search, filters, 'device'), [recent, search, filters]);
  // OrdersList's own rule: the stuck pending sales need attention too.
  const attention = useMemo(() => needsAttention(orders, { stuckCommandIds: state.stuck?.commandIds }), [orders, state.stuck]);
  // v2's Orders has no title bar on a wide window; a phone keeps the header for the drawer's Menu.
  const openMenu = useFrameMenu();
  // Without a header the sign-in / refused strip lies over the top of the screen (as on the Sale screen).
  const topInset = useContext(StripHeightContext);
  if (!session) return <Redirect href="/login" />;
  return <View className="flex-1 bg-background" role="main" aria-label="Orders">
    <Stack.Screen options={{ title: 'Orders', headerShown: !!openMenu, headerLeft: () => <FrameMenuButton />, headerRight: () => <View className="pr-4"><AreaAccountButton /></View> }} />
    <View className="flex-row items-center gap-2 px-4 pb-2" style={{ paddingTop: 16 + topInset }}>
      <SearchInput className="flex-1" value={search} onChangeText={setSearch} placeholder="Search Orders"
        accessibilityLabel="Search Orders" testID="orders-search" />
      {!openMenu && <AreaAccountButton />}
    </View>
    <View className="px-4 pb-2">
      <OrderFilterBar value={filters} onChange={setFilters} fields={ORDERS_SCREEN_FILTER_FIELDS}
        options={options} timezone="device" testID="orders-filter-bar" />
    </View>
    <ScrollView className="flex-1" contentContainerClassName="gap-3 p-4">
      {attention.length > 0 ? <>
        <Text accessibilityRole="header" className="text-xl font-semibold text-foreground">Needs attention</Text>
        <OrdersTable testID="orders-attention" orders={attention} onRetry={requeue} stuck={state.stuck}
          formatDate={formatDate} onOpen={setOpenId} />
      </> : null}
      {orders.length > 0
        ? <OrdersTable testID="orders-table" orders={orders} formatDate={formatDate} onOpen={setOpenId} />
        : <Text testID="orders-empty" className="text-muted-foreground">No sales yet. Completed sales appear here.</Text>}
    </ScrollView>
    {/* Looked up in `recent`, not the filtered list: the sheet shows live sync status and survives a search. */}
    <OrderDetailSheet order={recent.find((order) => order.id === openId) ?? null} onClose={() => setOpenId(null)}
      formatDate={formatDate} onRetry={requeue} onFlush={flush} stuck={state.stuck} />
  </View>;
}
