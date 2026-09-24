import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, Text, View, useWindowDimensions } from 'react-native';
import { Redirect, router, Stack } from 'expo-router';

import { ConnectorProvider } from '@tallyui/core';
import { withStockOverlay } from '@tallyui/pos';

import { Catalogue } from '../components/catalogue';
import { Cart } from '../components/cart';
import { Tender } from '../components/tender';
import { Receipt } from '../components/receipt';
import { SyncStatus } from '../components/sync-status';
import { markBusy } from '../lib/live-tab';
import { needsAttention } from '../lib/order-store';
import { useOutboxContext } from '../lib/outbox-context';
import { authHeaders, posConnector } from '../lib/pos-connector';
import { getRegisterId } from '../lib/register';
import { defaultStorage, type Session } from '../lib/session';
import { useSession } from '../lib/session-context';
import { fetchStoreSettings, loadCachedSettings, saveCachedSettings, StoreSettingsError, type StoreSettings } from '../lib/store-settings';
import { useSale } from '../lib/use-sale';
import { useReplicatedProducts, type SyncState } from '../lib/use-replicated-products';

const connector = posConnector;
const traits = connector.traits.product;

const STATE_LABEL: Record<SyncState, string> = {
  connecting: 'Connecting',
  syncing: 'Syncing',
  synced: 'Up to date',
  error: 'Sync error',
  offline: 'Offline · cached catalogue',
};

export default function ProductsScreen() {
  const { session, signOut, reportUnauthorized } = useSession();
  if (!session) return <Redirect href="/login" />;
  return <SettingsScreen key={session.baseUrl} session={session} signOut={signOut} onUnauthorized={reportUnauthorized} />;
}

type SignedInProps = { session: Session; signOut: () => void; onUnauthorized: () => void };

function SettingsScreen(props: SignedInProps) {
  const { session, onUnauthorized } = props;
  const [settings, setSettings] = useState(() => loadCachedSettings(defaultStorage(), session.baseUrl));
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setError(null);
    void fetchStoreSettings(session).then((next) => {
      if (!active) return;
      saveCachedSettings(defaultStorage(), session.baseUrl, next);
      setSettings(next);
      setOffline(false);
    }).catch((error: Error) => {
      if (!active) return;
      if (error instanceof StoreSettingsError && error.code === 'unauthorized') onUnauthorized();
      else {
        setError(error.message);
        setOffline(error instanceof StoreSettingsError && error.code === 'unreachable');
      }
    });
    return () => { active = false; };
  }, [session, onUnauthorized, attempt]);
  if (!settings) return <View dataSet={{ print: 'hide' }} className="flex-1 items-center justify-center gap-4">
    <Text className={error ? 'text-destructive' : 'text-muted-foreground'}>{error ?? 'Loading store settings…'}</Text>
    {error ? <Pressable accessibilityRole="button" onPress={() => setAttempt(attempt + 1)} className="rounded-md border border-border bg-card px-4 py-3"><Text className="text-center text-foreground">Retry</Text></Pressable> : null}
  </View>;
  return <SignedInProducts {...props} settings={settings} settingsStatus={offline ? 'Offline' : error} />;
}

function SignedInProducts({ session, signOut, onUnauthorized, settings, settingsStatus }: SignedInProps & {
  settings: StoreSettings; settingsStatus: string | null;
}) {
  const headers = useMemo(() => authHeaders(session.token), [session.token]);
  const { products, state, error, lastSyncedAt, stockOverlay, lastStockCheckAt, reconcileStock } =
    useReplicatedProducts(connector, headers, session.baseUrl, onUnauthorized);
  const [registerId] = useState(() => getRegisterId(defaultStorage()));
  const { record, state: outboxState, recent } = useOutboxContext();
  const stockWarned = useRef(new Set<string>());
  useEffect(() => {
    const fresh = recent.filter((order) => order.syncStatus === 'applied' && !stockWarned.current.has(order.id)
      && order.warnings?.some((warning) => warning.code === 'insufficient_stock'));
    for (const order of fresh) stockWarned.current.add(order.id);
    // The store was short, so local stock is stale.
    if (fresh.length) void reconcileStock();
  }, [recent, reconcileStock]);
  const attentionCount = needsAttention(recent).length;
  const sale = useSale(settings, { registerId, cashierRef: session.email, onSaleCompleted: record });
  useEffect(() => {
    markBusy('payment', sale.stage.kind === 'tender');
    return () => markBusy('payment', false);
  }, [sale.stage.kind]);
  const { width } = useWindowDimensions();
  const traitContext = useMemo(() => ({ currency: settings.currency }), [settings.currency]);

  // Reconciled stock over replicated stock, for everything the catalogue shows (ADR-060).
  const sorted = useMemo(
    () => products.map((doc) => withStockOverlay(doc, connector.reconcile?.stock, stockOverlay))
      .filter(traits.isSellable).sort((a, b) => traits.getName(a).localeCompare(traits.getName(b))),
    [products, stockOverlay],
  );
  const sellableCount = sorted.length;
  const statusText = `${connector.name} · ${STATE_LABEL[state]} · ${sellableCount.toLocaleString()} products`
    + (error ? ` · ${error}` : '');

  return (
    <ConnectorProvider connector={connector} traitContext={traitContext}>
      <Stack.Screen options={{ title: 'Products', headerShown: sale.stage.kind !== 'receipt', headerRight: () => (
        <View dataSet={{ print: 'hide' }} className="flex-row gap-4">
        <Pressable accessibilityRole="button" onPress={() => router.push('/orders')}>
          <Text className="text-foreground">Orders{attentionCount ? ` (${attentionCount})` : ''}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={() => { signOut(); router.replace('/login'); }}>
          <Text className="text-foreground">Sign out</Text>
        </Pressable>
        </View>
      ) }} />
      {sale.stage.kind === 'receipt' ? <Receipt order={sale.stage.order} settings={settings}
        cashier={session.name || session.email} registerId={registerId} newSale={sale.newSale} /> :
        <View dataSet={{ print: 'hide' }} className="flex-1 bg-background">
          {settingsStatus ? <Text className="text-destructive">{settingsStatus}</Text> : null}
          <View className="flex-1" style={{ flexDirection: width >= 900 ? 'row' : 'column' }}>
            <View className="flex-1">
              <Catalogue products={sorted} traits={traits} currency={settings.currency} lastSyncedAt={lastSyncedAt}
                lastStockCheckAt={lastStockCheckAt}
                onSelect={(entry) => sale.add(entry, traits)} statusText={statusText} />
              <SyncStatus state={outboxState} />
            </View>
            <View className="flex-1 border-t border-border bg-card">
              {sale.stage.kind === 'cart' ? <Cart sale={sale} /> : <Tender sale={sale} />}
            </View>
          </View>
        </View>}
    </ConnectorProvider>
  );
}
