import { useContext, useMemo, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { Redirect, router, Stack, type Href } from 'expo-router';
import { Button, OrderFilterBar, SearchInput, Text as ButtonText } from '@tallyui/components';
import { getDeviceId, needsAttention, type OrderFilterValue } from '@tallyui/pos';
import { AreaAccountButton, FrameMenuButton, frameStep, useFrameMenu } from '../components/app-frame';
import { OrderDetailSheet } from '../components/order-detail-sheet';
import { OrdersTable } from '../components/orders-table';
import { StoreOrderDetailSheet } from '../components/store-order-detail-sheet';
import { StripHeightContext } from '../components/store-refused';
import { useOutboxContext } from '../lib/outbox-context';
import { useSession } from '../lib/session-context';
import { defaultStorage, REGISTER_ID_KEY, type Session } from '../lib/session';
import { useTillName } from '../lib/till-name';
import { formatDate } from '../lib/format-date';
import { refundsCollection } from '../lib/order-store';
import { filterOrders, orderFilterOptions } from '../lib/order-filters';
import { mergeOrderRows, useStoreOrders, type OrdersRow } from '../lib/store-orders';
import { orderBillingCell } from '../lib/orders-table';
import { requestReopen } from '../lib/reopen-order';

export const ORDERS_LOADING_TEXT = 'Loading orders…';
export const ORDERS_EMPTY_TEXT = 'No orders yet.';
export const ORDERS_NO_MATCH_TEXT = 'No orders match.';
export const ORDERS_OFFLINE_TEXT = "Can't reach the store. Showing this till's sales.";
export const ORDERS_FAILED_TEXT = "Couldn't load the store's orders. Showing this till's sales.";

export default function OrdersScreen() {
  const { session, reportUnauthorized } = useSession();
  if (!session) return <Redirect href="/login" />;
  return <StoreWideOrders session={session} onUnauthorized={reportUnauthorized} />;
}

// v2's Orders: every order in the store, newest first, under this till's sales that haven't reached it yet.
function StoreWideOrders({ session, onUnauthorized }: { session: Session; onUnauthorized: () => void }) {
  const { recent, requeue, flush, state, orders: localOrders } = useOutboxContext();
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<OrderFilterValue>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const [openStoreId, setOpenStoreId] = useState<string | null>(null);
  // A sale reaching the store changes this count, and the store's first page is read again to list it.
  const appliedCount = useMemo(() => recent.filter((order) => order.syncStatus === 'applied').length, [recent]);
  const store = useStoreOrders(session, search, filters, appliedCount, onUnauthorized);
  // The Register pill's one option is this till: its sales carry its device id (outbox-context.tsx), as tally_register_id.
  const [registerId] = useState(() => getDeviceId(defaultStorage(), REGISTER_ID_KEY));
  const tillName = useTillName(defaultStorage(), session.baseUrl).tillName?.trim() || 'This till';
  const options = useMemo(() => ({ ...orderFilterOptions(recent, store.orders),
    register: [{ value: registerId, label: tillName }] }), [recent, store.orders, registerId, tillName]);
  const orders = useMemo(() => filterOrders(recent, search, filters, 'device'), [recent, search, filters]);
  // OrdersList's own rule: the stuck pending sales need attention too.
  const attention = useMemo(() => needsAttention(orders, { stuckCommandIds: state.stuck?.commandIds }), [orders, state.stuck]);
  // Without the store, the table is this till's own sales, as before Orders went store-wide.
  const fallback = store.failure !== null;
  const rows = useMemo<OrdersRow[]>(() => {
    if (fallback) return orders.map((order) => ({ kind: 'local', key: order.id, order }));
    const attended = new Set(attention.map((order) => order.id));
    return mergeOrderRows(orders.filter((order) => order.syncStatus !== 'applied' && !attended.has(order.id)), recent, store.orders);
  }, [fallback, orders, attention, recent, store.orders]);
  const firstLoad = !fallback && store.loading && !store.loaded;
  const narrowed = search.trim() !== '' || Object.values(filters).some((value) => value !== undefined);
  // v2's Orders has no title bar on a wide window; a phone keeps the header for the drawer's Menu.
  const openMenu = useFrameMenu();
  // Without a header the sign-in / refused strip lies over the top of the screen (as on the Sale screen).
  const topInset = useContext(StripHeightContext);
  const openSale = recent.find((order) => order.id === openId) ?? null;
  const openSaleStore = openId ? store.orders.find((order) => order.clientOrderId === openId) ?? null : null;
  const openStore = store.orders.find((order) => order.id === openStoreId) ?? null;
  return <View className="flex-1 bg-background" role="main" aria-label="Orders">
    <Stack.Screen options={{ title: 'Orders', headerShown: !!openMenu, headerLeft: () => <FrameMenuButton />, headerRight: () => <View className="pr-4"><AreaAccountButton /></View> }} />
    <View className="flex-row items-center gap-2 px-4 pb-2" style={{ paddingTop: 16 + topInset }}>
      <SearchInput className="flex-1" value={search} onChangeText={setSearch} placeholder="Search Orders"
        accessibilityLabel="Search Orders" testID="orders-search" />
      {!openMenu && <AreaAccountButton />}
    </View>
    <View className="px-4 pb-2">
      <OrderFilterBar value={filters} onChange={setFilters} fields={store.filterFields}
        options={options} timezone="device" testID="orders-filter-bar" />
    </View>
    <ScrollView className="flex-1" contentContainerClassName="gap-3 p-4">
      {attention.length > 0 ? <>
        <Text accessibilityRole="header" className="text-xl font-semibold text-foreground">Needs attention</Text>
        <OrdersTable testID="orders-attention" orders={attention} onRetry={requeue} stuck={state.stuck}
          formatDate={formatDate} onOpen={setOpenId} days />
      </> : null}
      {fallback ? <View className="flex-row items-center gap-3">
        <Text role="alert" className="text-sm text-muted-foreground">
          {store.failure === 'network' ? ORDERS_OFFLINE_TEXT : ORDERS_FAILED_TEXT}</Text>
        <Button size="sm" variant="outline" testID="orders-retry" accessibilityLabel="Retry loading the store's orders"
          disabled={store.loading} onPress={store.retry}><ButtonText>Retry</ButtonText></Button>
      </View> : null}
      {rows.length > 0
        ? <OrdersTable testID="orders-table" rowTestID="orders-row" rows={rows} formatDate={formatDate} onOpen={setOpenId}
          onOpenStore={(order) => setOpenStoreId(order.id)} billing={store.billing} days />
        : firstLoad ? null : <Text testID="orders-empty" className="text-muted-foreground">
          {narrowed ? ORDERS_NO_MATCH_TEXT : ORDERS_EMPTY_TEXT}</Text>}
      {firstLoad ? <Text testID="orders-loading" className="text-muted-foreground">{ORDERS_LOADING_TEXT}</Text> : null}
      {!fallback && store.unreadable > 0 ? <Text testID="orders-unreadable" className="text-sm text-muted-foreground">
        {`${store.unreadable} ${store.unreadable === 1 ? 'order' : 'orders'} couldn't be read.`}</Text> : null}
      {!fallback && store.total !== undefined ? <Text testID="orders-count" className="text-sm text-muted-foreground">
        {`Showing ${store.orders.length} of ${store.total}`}</Text> : null}
      {!fallback && store.hasMore ? <Button variant="outline" className="self-center" testID="orders-load-more"
        disabled={store.loading} onPress={store.loadMore}><ButtonText>Load more</ButtonText></Button> : null}
    </ScrollView>
    {/* Looked up in `recent`, not the filtered list: the sheet shows live sync status and survives a search. Each sheet gets
        the Billing Address its table row shows, which a phone's row leaves out. */}
    <OrderDetailSheet order={openSale} onClose={() => setOpenId(null)}
      storeOrder={openSaleStore} refunds={refundsCollection(localOrders)}
      billing={openSale ? orderBillingCell({ kind: 'local', key: openSale.id, order: openSale, storeId: openSaleStore?.id }, store.billing) : undefined}
      formatDate={formatDate} onRetry={requeue} onFlush={flush} stuck={state.stuck} />
    <StoreOrderDetailSheet order={openStore} onClose={() => setOpenStoreId(null)} formatDate={formatDate}
      billing={openStore ? orderBillingCell({ kind: 'store', key: openStore.id, order: openStore }, store.billing) : undefined}
      onReopen={(order) => {
        // The Sale screen takes the request and starts the new sale; Orders goes back to it as the rail does.
        requestReopen(order); setOpenStoreId(null);
        const step = frameStep('orders', 'sale'); if (step) router[step.method](step.href as Href);
      }} />
  </View>;
}
