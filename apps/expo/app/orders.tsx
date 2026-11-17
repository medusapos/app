import { useMemo, useState } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { AppText as Text } from '../components/app-text';
import { Redirect, Stack } from 'expo-router';
import { OrderFilterBar, OrdersList, SearchInput } from '@tallyui/components';
import type { OrderFilterValue } from '@tallyui/pos';
import { FrameMenuButton } from '../components/app-frame';
import { OrderDetailSheet } from '../components/order-detail-sheet';
import { version as appVersion } from '../package.json';
import { feedbackUrl, openFeedbackUrl } from '../lib/feedback-url';
import { useOutboxContext } from '../lib/outbox-context';
import { useSession } from '../lib/session-context';
import { formatDate } from '../lib/format-date';
import { filterOrders, orderFilterOptions, ORDERS_SCREEN_FILTER_FIELDS } from '../lib/order-filters';

export default function OrdersScreen() {
  const { session } = useSession();
  const { recent, requeue } = useOutboxContext();
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<OrderFilterValue>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const options = useMemo(() => orderFilterOptions(recent), [recent]);
  const orders = useMemo(() => filterOrders(recent, search, filters, 'device'), [recent, search, filters]);
  if (!session) return <Redirect href="/login" />;
  return <View className="flex-1 bg-background">
    <Stack.Screen options={{ title: 'Orders', headerLeft: () => <FrameMenuButton /> }} />
    <View className="flex-row items-center gap-2 px-4 pt-4 pb-2">
      <SearchInput className="flex-1" value={search} onChangeText={setSearch} placeholder="Search Orders"
        accessibilityLabel="Search Orders" testID="orders-search" />
    </View>
    <View className="px-4 pb-2">
      <OrderFilterBar value={filters} onChange={setFilters} fields={ORDERS_SCREEN_FILTER_FIELDS}
        options={options} timezone="device" testID="orders-filter-bar" />
    </View>
    <OrdersList orders={orders} onRetry={requeue} formatDate={formatDate}
      onOpen={(row) => { if ('lines' in row) setOpenId(row.id); }} footer={
        <Pressable accessibilityRole="link" className="min-h-11 justify-center" onPress={() => { openFeedbackUrl(feedbackUrl({
          appVersion, platform: Platform.OS,
          userAgent: Platform.OS === 'web' ? navigator.userAgent : undefined,
          backendUrl: session.baseUrl,
        })); }}>
          <Text className="text-center text-sm text-muted-foreground">Send feedback</Text>
        </Pressable>
    } />
    {/* Looked up in `recent`, not the filtered list: the sheet shows live sync status and survives a search. */}
    <OrderDetailSheet order={recent.find((order) => order.id === openId) ?? null} onClose={() => setOpenId(null)}
      formatDate={formatDate} />
  </View>;
}
