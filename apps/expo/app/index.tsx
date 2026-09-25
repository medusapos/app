import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, Text, View, useWindowDimensions } from 'react-native';
import { Redirect, router, Stack } from 'expo-router';

import { StoreSettingsChoiceScreen } from '@tallyui/components';
import { ConnectorProvider, SignInError, type ServerCapabilities, type StoreSettings as PricingSettings, type SyncContext } from '@tallyui/core';
import { TaxProvider, taxProviderProps, useStoreSettings, withPricingContext, withStockOverlay } from '@tallyui/pos';

import { Catalogue } from '../components/catalogue';
import { Cart } from '../components/cart';
import { CartBar } from '../components/cart-bar';
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
import {
  clearSettingsRegion, fetchStoreSettings, loadCachedPricing, loadCachedSettings, loadSettingsChoice, saveCachedPricing,
  saveCachedSettings, saveSettingsChoice, StoreSettingsError, type StoreSettings,
} from '../lib/store-settings';
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
  const { session, signOut, reportUnauthorized, mergeCapabilities } = useSession();
  if (!session) return <Redirect href="/login" />;
  return <SettingsScreen key={session.baseUrl} session={session} signOut={signOut} onUnauthorized={reportUnauthorized}
    onCapabilities={mergeCapabilities} />;
}

type SignedInProps = { session: Session; signOut: () => void; onUnauthorized: () => void;
  onCapabilities: (fresh: ServerCapabilities | undefined) => void };

function SettingsScreen(props: SignedInProps) {
  const { session, onUnauthorized, onCapabilities } = props;
  // Once per store (this screen is keyed by it): re-read the order.create capability a restored session was saved with (ADR-062).
  useEffect(() => {
    let active = true;
    connector.capabilities?.({ connectorId: connector.id, baseUrl: session.baseUrl, headers: authHeaders(session.token) })
      .then((fresh) => { if (active) onCapabilities(fresh); })
      .catch((error: unknown) => { if (active && error instanceof SignInError) onUnauthorized(); });
    return () => { active = false; };
  }, [session.baseUrl, onCapabilities, onUnauthorized]);
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
  if (!settings) return <SettingsMessage text={error ?? 'Loading store settings…'} actions={error ? { Retry: () => setAttempt(attempt + 1) } : {}} />;
  return <PricingScreen {...props} settings={settings} settingsStatus={offline ? 'Offline' : error} />;
}

function SettingsMessage({ text, actions }: { text: string; actions: Record<string, () => void> }) {
  const buttons = Object.entries(actions);
  return <View dataSet={{ print: 'hide' }} className="flex-1 items-center justify-center gap-4">
    <Text className={buttons.length ? 'text-destructive' : 'text-muted-foreground'}>{text}</Text>
    {buttons.map(([label, onPress]) => <Pressable key={label} accessibilityRole="button" onPress={onPress} className="rounded-md border border-border bg-card px-4 py-3"><Text className="text-center text-foreground">{label}</Text></Pressable>)}
  </View>;
}

type PricingProps = SignedInProps & { settings: StoreSettings; settingsStatus: string | null };

// TallyUI's store settings (TV4) price and tax every sale the way Medusa charges in the till's region.
function PricingScreen(props: PricingProps) {
  const { session, settings } = props;
  const token = useRef(session.token);
  token.current = session.token;
  const [attempt, setAttempt] = useState(0);
  // D1: the plugin taxes each order by the stock location's address, so the till's country is always its country.
  const country = settings.location.countryCode.toLowerCase();
  // Read per request (as useOutbox), so a token refresh keeps this identity and never re-resolves; a new country does.
  // The capability is a value dependency: only a new order.create version makes a new context, never a new session object.
  const orderCreate = session.capabilities?.orderCreate;
  const context = useMemo<SyncContext>(() => ({ connectorId: connector.id, baseUrl: session.baseUrl,
    headers: { get Authorization() { return authHeaders(token.current).Authorization; } },
    ...(orderCreate === undefined ? {} : { capabilities: { orderCreate } }) }), [session.baseUrl, attempt, country, orderCreate]);
  const store = useStoreSettings({
    connector, context, loadChoice: () => ({ ...loadSettingsChoice(defaultStorage(), session.baseUrl), country }),
    saveChoice: (choice) => saveSettingsChoice(defaultStorage(), session.baseUrl, choice),
    onSaveError: (error) => console.warn('Could not save the till\'s store settings choice:', error),
  });
  // A Retry never unmounts the POS or ends its sale (a money rule): the POS keeps the settings it shows (the same
  // object, so the tax context and replication stay) while a retry loads or fails, and until it resolves to new ones.
  const shown = useRef<{ pricing: PricingSettings; syncContext: SyncContext } | null>(null);
  const pricing = useMemo(() => {
    const previous = shown.current?.pricing ?? null;
    if (store.state === 'ready') return previous && JSON.stringify(previous) === JSON.stringify(store.settings) ? previous : store.settings;
    if (store.state === 'error') return previous ?? loadCachedPricing(defaultStorage(), session.baseUrl);
    return store.state === 'loading' ? previous : null;
  }, [store, session.baseUrl]);
  useEffect(() => { if (store.state === 'ready') saveCachedPricing(defaultStorage(), session.baseUrl, store.settings); }, [store, session.baseUrl]);
  const live = useMemo(() => pricing && { pricing, syncContext: withPricingContext(context, pricing) }, [context, pricing]);
  // A sale in progress keeps the POS on what it shows (prices, tax, catalogue, currency; a money rule): new
  // settings, and the choose, unsupported or error screens, wait until the sale is idle.
  const [busy, setBusy] = useState(false);
  const held = busy && shown.current !== null;
  if (!held) shown.current = live;
  const regionNames = useRef(new Map<string, string>());
  const again = () => setAttempt(attempt + 1);

  if (store.state === 'choose' && !held) {
    for (const region of store.choices.regions ?? []) regionNames.current.set(region.id, region.name);
    const { countries, ...choices } = store.choices;
    if (countries && !countries.includes(country)) {
      // No region in the choice: Medusa's default region, which wins again after any pick, so only Retry.
      const region = store.initial?.region;
      return <SettingsMessage text={`Stock location ${settings.location.name} is in ${country.toUpperCase()}, which ${region ? `region ${regionNames.current.get(region) ?? region}` : 'the store\'s default region'} does not cover.`}
        actions={region ? { Retry: again, 'Choose another region': () => { clearSettingsRegion(defaultStorage(), session.baseUrl); again(); } } : { Retry: again }} />;
    }
    return <StoreSettingsChoiceScreen choices={choices} initial={store.initial} title="Set up this till"
      onSubmit={(choice) => store.choose({ ...choice, country })} />;
  }
  if (store.state === 'unsupported' && !held) return <SettingsMessage text="This backend can't supply store settings" actions={{ Retry: again }} />;
  const pos = shown.current;
  if (store.state === 'error' && !pos) return <SettingsMessage text={store.error instanceof Error ? store.error.message : String(store.error)} actions={{ Retry: store.retry }} />;
  if (!pos) return <SettingsMessage text="Loading store settings…" actions={{}} />;
  return <TaxProvider {...taxProviderProps(pos.pricing)}>
    <SignedInProducts {...props} pricing={pos.pricing} syncContext={pos.syncContext} onBusy={setBusy}
      settingsStatus={props.settingsStatus ?? (store.state === 'error' ? 'Offline'
        : store.state === 'choose' || store.state === 'unsupported' ? 'Store settings changed; this applies after the current sale' : null)} onRetry={store.state === 'error' ? store.retry : undefined} />
  </TaxProvider>;
}

function SignedInProducts({ session, signOut, onUnauthorized, settings, settingsStatus, pricing, syncContext, onRetry, onBusy }: PricingProps & {
  pricing: PricingSettings; syncContext: SyncContext; onRetry?: () => void; onBusy: (busy: boolean) => void;
}) {
  const { products, state, error, lastSyncedAt, stockOverlay, lastStockCheckAt, reconcileStock, unlisted } =
    useReplicatedProducts(connector, syncContext, onUnauthorized);
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
  // The session's capability, not the held sync context's: a sale checks what the store accepts now (ADR-062).
  const sale = useSale(pricing, { registerId, cashierRef: session.email, capabilities: session.capabilities, onSaleCompleted: record });
  useEffect(() => onBusy(!sale.idle), [sale.idle, onBusy]);
  useEffect(() => {
    markBusy('payment', sale.stage.kind === 'tender');
    return () => markBusy('payment', false);
  }, [sale.stage.kind]);
  const { width } = useWindowDimensions();
  // Phone mode (ADR 0009): products or the cart at full height, the tender over both; a new sale starts on products.
  const phone = width < 600;
  const [cartOpen, setCartOpen] = useState(false);
  useEffect(() => { if (sale.stage.kind === 'receipt') setCartOpen(false); }, [sale.stage.kind]);
  const traitContext = useMemo(() => ({ currency: pricing.currency }), [pricing.currency]);

  // Reconciled stock over replicated stock, for everything the catalogue shows (ADR-060).
  const sorted = useMemo(
    () => products.map((doc) => withStockOverlay(doc, connector.reconcile?.stock, stockOverlay))
      .filter(traits.isSellable).sort((a, b) => traits.getName(a).localeCompare(traits.getName(b))),
    [products, stockOverlay],
  );
  const sellableCount = sorted.length;
  const statusText = `${connector.name} · ${STATE_LABEL[state]} · ${sellableCount.toLocaleString()} products`
    + (unlisted?.count ? ` · ${unlisted.count.toLocaleString()} not sold in this channel${unlisted.stale ? ' (last check failed)' : ''}` : '')
    + (error ? ` · ${error}` : '');
  const catalogue = <View className="flex-1">
    <Catalogue products={sorted} traits={traits} currency={pricing.currency} lastSyncedAt={lastSyncedAt}
      lastStockCheckAt={lastStockCheckAt}
      onSelect={(entry) => sale.add(entry, traits)} statusText={statusText} />
    <SyncStatus state={outboxState} />
  </View>;

  return (
    <ConnectorProvider connector={connector} traitContext={traitContext}>
      <Stack.Screen options={{ title: phone && cartOpen ? 'Cart' : 'Products', headerShown: sale.stage.kind !== 'receipt', headerRight: () => (
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
          {/* Only while idle: new settings never land mid-sale (useSale also holds them until then). */}
          {onRetry && sale.idle ? <Pressable accessibilityRole="button" onPress={onRetry}><Text className="text-foreground underline">Retry</Text></Pressable> : null}
          {!phone ? <View className="flex-1" style={{ flexDirection: width >= 900 ? 'row' : 'column' }}>
            {catalogue}
            <View className="flex-1 border-t border-border bg-card">
              {sale.stage.kind === 'cart' ? <Cart sale={sale} /> : <Tender sale={sale} />}
            </View>
          </View> : sale.stage.kind === 'tender' ? <View className="flex-1 bg-card"><Tender sale={sale} /></View>
            : cartOpen ? <View className="flex-1 bg-card">
              <View className="border-b border-border">
                <Pressable accessibilityRole="button" accessibilityLabel="Products" onPress={() => setCartOpen(false)}
                  className="min-h-11 self-start justify-center px-3"><Text className="text-primary">‹ Products</Text></Pressable>
              </View>
              <Cart sale={sale} />
            </View> : <>{catalogue}<CartBar sale={sale} onOpen={() => setCartOpen(true)} /></>}
        </View>}
    </ConnectorProvider>
  );
}
