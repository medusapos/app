import { useEffect, useMemo, useRef, useState, useContext } from 'react';
import { Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { Redirect, Stack } from 'expo-router';
import { getCalendars } from 'expo-localization';

import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, Button, Cart, CartBar,
  CartNoteInput, Catalogue, ChangeDisplay, CustomerPicker, Dialog, DialogContent, DialogTitle, IconButton, OpenSaleTabs, ParkedSales, Receipt, StoreSettingsChoiceScreen, SyncStatus, Tender, Text as UiText, XIcon,
  DEFAULT_PRODUCT_FILTERS, type ProductFilters,
} from '@tallyui/components';
import { ConnectorProvider, ConnectorUnauthorizedError, resolvePrice, SignInError, type ServerCapabilities, type StoreSettings as PricingSettings, type SyncContext, type TallyConnector } from '@tallyui/core';
import {
  capturedMinor, catalogueEntries, findEntryByCode, getDeviceId, needsAttention, openSales, saleLogger, SALE_SAVING, summarizeOutboxHealth, TaxProvider, taxProviderProps, useParkedSales, useSale, useStoreSettings,
  withPricingContext, withStockOverlay,
  normalizeCatalogueViewState, type CatalogueViewState,
} from '@tallyui/pos';

import { FrameMenuButton, useFrameBadge } from '../components/app-frame';
import { CartAddMenu } from '../components/cart-add-menu';
import { CartSettingsButton } from '../components/cart-settings';
import { CouponField, couponDiscountMinor, couponsEnabled } from '../components/coupon-field';
import { EarlierSaleNote, EARLIER_SALE_SAVING } from '../components/earlier-sale-note';
import { EmailReceipt } from '../components/email-receipt';
import { PriceCheckBanner } from '../components/price-check-banner';
import { ProductSettingsButton } from '../components/product-settings';
import {
  GETTING_READY, IN_ROW, RegisterClosedSheet, RegisterGate, RegisterPanelSheet, TillRegisterBar, useGatedSale,
} from '../components/register';
import { StripHeightContext } from '../components/store-refused';
import { UserSheet } from '../components/user-sheet';
import { loadCatalogueView, saveCatalogueView } from '../lib/catalogue-view';
import { useCartSettings } from '../lib/cart-settings';
import { createMedusaDiscountCodes } from '../lib/coupons';
import { demoTillChoice, isDemoAccount } from '../lib/demo';
import { clampNote } from '../lib/note-text';
import { withDemoSaleEvent } from '../lib/demo-analytics';
import { formatDate } from '../lib/format-date';
import { markBusy } from '../lib/live-tab';
import { draftsCollection } from '../lib/order-store';
import { useOutboxContext } from '../lib/outbox-context';
import { authHeaders, createPosConnector } from '../lib/pos-connector';
import { useProductSettings } from '../lib/product-settings';
import { useRegister } from '../lib/register-context';
import { useScannerSettings } from '../lib/scanner-settings';
import { forgetDeletedDefaultCustomer, useDefaultCustomer } from '../lib/default-customer';
import { defaultStorage, REGISTER_ID_KEY, type Session } from '../lib/session';
import { useSession } from '../lib/session-context';
import {
  clearSettingsRegion, fetchStoreSettings, loadCachedPricing, loadCachedSettings, loadSettingsChoice, saveCachedPricing,
  saveCachedSettings, saveSettingsChoice, StoreSettingsError, type StoreSettings,
} from '../lib/store-settings';
import { useReplicatedProducts, type SyncState } from '../lib/use-replicated-products';
import { useWedgeScan } from '../lib/use-wedge-scan';

const STATE_LABEL: Record<SyncState, string> = {
  connecting: 'Connecting',
  syncing: 'Syncing',
  synced: 'Up to date',
  error: 'Sync error',
  offline: 'Offline · cached catalogue',
};

// Merchant-facing name of @medusapos/medusa-plugin (#129).
const PLUGIN_NAME = 'the Medusa POS plugin';
// TallyUI #339/#341, use-store-settings.ts:48: unknown tax rounding retries until settings resolve.
const SETTINGS_RETRYING = "Can't reach the store's settings yet. Retrying…";

// ADR 0009: phone mode below 600 px.
const PHONE_BREAKPOINT = 600;
// ADR 0009: from 600 px, products and cart stack in a column below 900 px and sit in a row from 900 px.
const ROW_BREAKPOINT = 900;

// The rate arrives in parts per million (10 000 ppm = 1%).
const taxLabel = (ppm: number) => `VAT ${ppm / 10000}%`;

export default function ProductsScreen() {
  const { session, signOut, reportUnauthorized, reportNoPosAccess, mergeCapabilities } = useSession();
  const lastEmail = useRef<string | undefined>(undefined);
  if (!session) return <Redirect href={isDemoAccount(lastEmail.current ?? '') ? '/demo' : '/login'} />;
  lastEmail.current = session.email;
  return <StoreSettingsGate key={session.baseUrl} session={session} signOut={signOut} onUnauthorized={reportUnauthorized}
    onNoPosAccess={reportNoPosAccess} onCapabilities={mergeCapabilities} />;
}

type SignedInProps = { session: Session; signOut: () => void; onUnauthorized: () => void; onNoPosAccess: () => void;
  onCapabilities: (fresh: ServerCapabilities | undefined) => void };

function StoreSettingsGate(props: SignedInProps) {
  const { session, onUnauthorized, onNoPosAccess, onCapabilities } = props;
  const [connector] = useState(createPosConnector);
  // Once per store (this screen is keyed by it): re-read the order.create capability a restored session was saved with (ADR-062).
  useEffect(() => {
    let active = true;
    connector.capabilities?.({ connectorId: connector.id, baseUrl: session.baseUrl, headers: authHeaders(session.token) })
      .then((fresh) => { if (active) onCapabilities(fresh); })
      .catch((error: unknown) => { if (active && error instanceof SignInError && error.code === 'invalid_credentials') onUnauthorized(); });
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
      else if (error instanceof StoreSettingsError && error.code === 'forbidden') onNoPosAccess();
      else {
        setError(error.message);
        setOffline(error instanceof StoreSettingsError && error.code === 'unreachable');
      }
    });
    return () => { active = false; };
  }, [session, onUnauthorized, onNoPosAccess, attempt]);
  if (!settings) return <SettingsMessage text={error ?? 'Loading store settings…'} actions={error ? { Retry: () => setAttempt(attempt + 1) } : {}} />;
  return <PricingScreen {...props} connector={connector} settings={settings} settingsStatus={offline ? 'Offline' : error} />;
}

function SettingsMessage({ text, actions }: { text: string; actions: Record<string, () => void> }) {
  const buttons = Object.entries(actions);
  return <>
    <EarlierSaleNote />
    <View dataSet={{ print: 'hide' }} className="flex-1 items-center justify-center gap-4">
      <Text className={buttons.length ? 'text-destructive' : 'text-muted-foreground'}>{text}</Text>
      {buttons.map(([label, onPress]) => <Pressable key={label} accessibilityRole="button" onPress={onPress} className="rounded-md border border-border bg-card px-4 py-3"><Text className="text-center text-foreground">{label}</Text></Pressable>)}
    </View>
  </>;
}

type PricingProps = SignedInProps & { connector: TallyConnector; settings: StoreSettings; settingsStatus: string | null };

// TallyUI's store settings (TV4) price and tax every sale the way Medusa charges in the till's region.
function PricingScreen(props: PricingProps) {
  const { session, settings, connector } = props;
  const token = useRef(session.token);
  token.current = session.token;
  const [attempt, setAttempt] = useState(0);
  // D1: the plugin taxes each order by the stock location's address, so the till's country is always its country.
  const country = settings.location.countryCode.toLowerCase();
  // Read per request (as the outbox's transport), so a token refresh keeps this identity and never re-resolves; a new country does.
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
  const demoChosen = useRef(false);
  const autoChooseDemo = store.state === 'choose' && !held && !demoChosen.current && isDemoAccount(session.email)
    && (!store.choices.countries || store.choices.countries.includes(country));
  useEffect(() => {
    if (!autoChooseDemo || demoChosen.current || store.state !== 'choose') return;
    demoChosen.current = true;
    store.choose({ ...demoTillChoice(store.choices, store.initial), country });
  }, [autoChooseDemo, store, country]);

  if (store.state === 'choose' && !held) {
    for (const region of store.choices.regions ?? []) regionNames.current.set(region.id, region.name);
    const { countries, ...choices } = store.choices;
    if (countries && !countries.includes(country)) {
      // No region in the choice: Medusa's default region, which wins again after any pick, so only Retry.
      const region = store.initial?.region;
      return <SettingsMessage text={`Stock location ${settings.location.name} is in ${country.toUpperCase()}, which ${region ? `region ${regionNames.current.get(region) ?? region}` : 'the store\'s default region'} does not cover.`}
        actions={region ? { Retry: again, 'Choose another region': () => { clearSettingsRegion(defaultStorage(), session.baseUrl); again(); } } : { Retry: again }} />;
    }
    if (autoChooseDemo) return <SettingsMessage text="Setting up the demo till…" actions={{}} />;
    return <><EarlierSaleNote /><StoreSettingsChoiceScreen choices={choices} initial={store.initial} title="Set up this till"
      onSubmit={(choice) => store.choose({ ...choice, country })} /></>;
  }
  if (store.state === 'unsupported' && !held) return <SettingsMessage text="This backend can't supply store settings" actions={{ Retry: again }} />;
  const pos = shown.current;
  if (store.state === 'error' && !pos) return <SettingsMessage text={store.nextRetryAt !== undefined ? SETTINGS_RETRYING
    : store.error instanceof Error ? store.error.message : String(store.error)} actions={{ Retry: store.retry }} />;
  if (!pos) return <SettingsMessage text="Loading store settings…" actions={{}} />;
  return <TaxProvider {...taxProviderProps(pos.pricing)}>
    <SignedInProducts {...props} pricing={pos.pricing} syncContext={pos.syncContext} onBusy={setBusy}
      settingsStatus={props.settingsStatus ?? (store.state === 'error' ? 'Offline'
        : store.state === 'choose' || store.state === 'unsupported' ? 'Store settings changed; this applies after the current sale' : null)} onRetry={store.state === 'error' ? store.retry : undefined} />
  </TaxProvider>;
}

function SignedInProducts({ session, signOut, onUnauthorized, settings, settingsStatus, pricing, syncContext, onRetry, onBusy, connector }: PricingProps & {
  pricing: PricingSettings; syncContext: SyncContext; onRetry?: () => void; onBusy: (busy: boolean) => void;
}) {
  const traits = connector.traits.product;
  const { setSaleHold } = useSession();
  const { products, state, error, lastSyncedAt, stockOverlay, lastStockCheckAt, reconcileStock, unlisted, pullNotice, resumePull } =
    useReplicatedProducts(connector, syncContext, onUnauthorized);
  const online = state !== 'offline';
  const previousToken = useRef(session.token);
  useEffect(() => {
    if (previousToken.current !== session.token) resumePull();
    previousToken.current = session.token;
  }, [session.token, resumePull]);
  const [registerId] = useState(() => getDeviceId(defaultStorage(), REGISTER_ID_KEY));
  const topInset = useContext(StripHeightContext);
  const { record, isStored, state: outboxState, recent, savesInFlight, orders } = useOutboxContext();
  const stockWarned = useRef(new Set<string>());
  useEffect(() => {
    const fresh = recent.filter((order) => order.syncStatus === 'applied' && !stockWarned.current.has(order.id)
      && order.warnings?.some((warning) => warning.code === 'insufficient_stock'));
    for (const order of fresh) stockWarned.current.add(order.id);
    // The store was short, so local stock is stale.
    if (fresh.length) void reconcileStock();
  }, [recent, reconcileStock]);
  const attentionCount = needsAttention(recent).length;
  useFrameBadge('orders', attentionCount);
  // The session's capability, not the held sync context's: a sale checks what the store accepts now (ADR-062).
  // isStored: after a failed save (TallyUI #149), or every 5 s while a save hangs (#161), the tender offers Continue once
  // the outbox confirms the order is stored.
  // `session`: complete() stamps the sale with the register session (ADR 0017). The Cart's tender start
  // (useGatedSale) refuses until one is open; useSale pins the session in force at tender start (TallyUI #170), so a
  // close during the tender still reaches the stamp, which then makes the sale late.
  const { register, registerOutbox } = useRegister();
  const drafts = draftsCollection(orders);
  const { parked, discard } = useParkedSales(drafts);
  const [parkedOpen, setParkedOpen] = useState(false);
  const [switchRefusal, setSwitchRefusal] = useState<string | null>(null);
  const switchTo = (id: string | null) => { void sale.switchSale(id).then(setSwitchRefusal); };
  const [customerOpen, setCustomerOpen] = useState(false);
  const [filters, setFilters] = useState<ProductFilters>({ ...DEFAULT_PRODUCT_FILTERS, inStock: false });
  const entriesRef = useRef<ReturnType<typeof catalogueEntries>>([]);
  const token = useRef(session.token);
  token.current = session.token;
  const discountCodes = useMemo(() => createMedusaDiscountCodes({ baseUrl: session.baseUrl, token: () => token.current }), [session.baseUrl]);
  const { customer: defaultCustomer } = useDefaultCustomer(defaultStorage(), session.baseUrl);
  useEffect(() => {
    // The store no longer has this customer: useSale falls back to Guest on an idle cart or the next sale; an open sale keeps its customer.
    for (const order of recent) forgetDeletedDefaultCustomer(defaultStorage(), session.baseUrl, order.warnings);
  }, [recent, session.baseUrl]);
  const sale = useSale(pricing, { defaultCustomer, registerId, cashierRef: session.email, capabilities: session.capabilities, onSaleCompleted: isDemoAccount(session.email) ? withDemoSaleEvent(record) : record,
    discountCodes, isStored, session: register.saleSession, drafts, currentPrice: (variantId) => {
      const entry = entriesRef.current.find(({ variant }) => variant.id === variantId);
      return entry ? resolvePrice(entry.variant.prices, pricing.currency)?.current.amount : undefined;
    } });
  const { sale: cartSale, refused } = useGatedSale(sale);
  // v2's cart foot: one "Checkout {total}" opens the tender on Cash through the register gate, where the cashier picks
  // the method (Card terminal included), and a ⋮ menu holds Void, which asks first: the open sale has no copy to restore.
  const [voidOpen, setVoidOpen] = useState(false);
  const voidOffered = sale.order.lineItems.length > 0 && sale.order.payments.length === 0;
  const checkout = {
    onCheckout: () => cartSale.startTender('cash'),
    actions: voidOffered ? [{ label: 'Void', destructive: true, onPress: () => setVoidOpen(true) }] : [],
  };
  // Sign out unmounts this screen and closes the outbox, so it waits while `saving`: from complete()'s entry until the
  // save lands, or, after a failed one, until Retry stores it or Continue starts the next sale (the #150 review). It also
  // waits while an earlier sale's save is in flight after Continue: RxDB's close would wait on its write (#85 review).
  const signOutLocked = sale.saving || savesInFlight > 0;
  const lockMessage = sale.saving ? SALE_SAVING : EARLIER_SALE_SAVING;
  // The session's sale hold (ADR 0015): every sign-out waits while saving; automatic ones (a 401, a failed refresh)
  // also wait for the receipt to clear. Released on unmount without running a pending sign-out: whichever release
  // next leaves both holds clear runs it, if the token is unchanged — the next sale screen's, or OutboxProvider's
  // for the saves hold (see ADR 0015, "When the sale screen unmounts for another reason").
  const saleHold = sale.saving ? 'saving' : sale.stage.kind === 'receipt' ? 'receipt' : null;
  useEffect(() => setSaleHold(saleHold), [saleHold, setSaleHold]);
  useEffect(() => () => setSaleHold(null, false), [setSaleHold]);
  // After every render, so a refused add (a locked sale, a cart error) never leaves the hold on.
  // setBusy bails out on an unchanged value, so this can't loop.
  useEffect(() => onBusy(!sale.idle));
  // The settings hold starts with the tap, in the same render pass as any settings landing with it (a money rule).
  const add = (entry: Parameters<typeof sale.add>[0]) => { onBusy(true); sale.add(entry, traits); };
  useEffect(() => {
    markBusy('payment', sale.stage.kind === 'tender');
    return () => markBusy('payment', false);
  }, [sale.stage.kind]);
  const { width } = useWindowDimensions();
  // Phone mode (ADR 0009): products or the cart at full height, the tender over both; a new sale starts on products.
  const phone = width < PHONE_BREAKPOINT;
  const [viewState, setViewState] = useState(() => normalizeCatalogueViewState({
    ...loadCatalogueView(defaultStorage(), session.baseUrl), ...(phone ? { view: 'grid' } : {}),
  }));
  const { settings: productSettings, save: saveProductSettings, reset: resetProductSettings } = useProductSettings(defaultStorage(), session.baseUrl);
  const onViewStateError = (error: unknown) => console.warn('Could not load or save the catalogue view:', error);
  const onViewStateChange = (next: CatalogueViewState) => {
    setViewState(next);
    try { saveCatalogueView(defaultStorage(), session.baseUrl, next); } catch (error) { onViewStateError(error); }
  };
  const [cartOpen, setCartOpen] = useState(false);
  useEffect(() => { if (sale.stage.kind === 'receipt') setCartOpen(false); }, [sale.stage.kind]);
  const traitContext = useMemo(() => ({ currency: pricing.currency }), [pricing.currency]);

  // Reconciled stock over replicated stock, for everything the catalogue shows (ADR-060).
  const sorted = useMemo(
    () => products.map((doc) => withStockOverlay(doc, connector.reconcile?.stock, stockOverlay))
      .filter(traits.isSellable).sort((a, b) => traits.getName(a).localeCompare(traits.getName(b))),
    [products, stockOverlay],
  );
  const entries = useMemo(() => catalogueEntries(sorted, traits), [sorted]);
  entriesRef.current = entries;
  // Web only, while phone mode shows the cart view in the cart stage (ADR 0009); the products view's own SearchInput handles a scan there, so this never double-adds.
  const wedgeActive = phone && cartOpen && sale.stage.kind === 'cart';
  const [scanMiss, setScanMiss] = useState<string | null>(null);
  useEffect(() => { if (!wedgeActive) setScanMiss(null); }, [wedgeActive]);
  const { settings: scannerSettings } = useScannerSettings(defaultStorage(), session.baseUrl);
  const cartSettings = useCartSettings(defaultStorage(), session.baseUrl);
  useWedgeScan(wedgeActive, scannerSettings, (code) => {
    const entry = findEntryByCode(entries, code);
    if (entry) { add(entry); setScanMiss(null); } else setScanMiss(code);
  });
  const sellableCount = sorted.length;
  // On a phone the status line shares one line with the register pill (ADR 0017), so it drops the store name and
  // the unlisted count, and puts an error before the count, where the ellipsis leaves it.
  const productCount = `${sellableCount.toLocaleString()} ${sellableCount === 1 ? 'product' : 'products'}`;
  const statusText = phone ? `${STATE_LABEL[state]}${error ? ` · ${error}` : ''} · ${productCount}`
    : `${settings.storeName.trim() ? settings.storeName : connector.name} · ${STATE_LABEL[state]} · ${productCount}`
      + (unlisted?.count ? ` · ${unlisted.count.toLocaleString()} not sold in this channel${unlisted.stale ? ' (last check failed)' : ''}` : '')
      + (error ? ` · ${error}` : '');
  // Web has no 12/24-hour API and reports none; keep the locale default in that case.
  const clock = getCalendars()[0]?.uses24hourClock;
  const hour12 = clock == null ? undefined : !clock;
  // The order store may still be opening when a sale reaches tender (ADR 0015's backstop can take up to 10 s):
  // Complete would have nothing to save to, so the tender pane waits for it, live, instead. Cart and the
  // catalogue don't need a store to add lines, so only this pane is gated.
  const tenderPane = orders === null
    ? <Text accessibilityRole="alert" className="p-4 text-center text-muted-foreground">{GETTING_READY}</Text>
    : <Tender sale={sale} />;
  // The register control (ADR 0017): its pill brings up the gate (on a phone, the cart view, even with an empty cart).
  const [panelOpen, setPanelOpen] = useState(false);
  const [userSheetOpen, setUserSheetOpen] = useState(false);
  const displayName = session.name || session.email;
  const initials = (session.name ? session.name.trim().split(/\s+/).slice(0, 2).map((word) => word[0]).join('') : session.email[0]).toUpperCase();
  // The receipt's and the last closure's store (ADR 0018).
  const receiptStore = { name: settings.storeName, address: settings.location.addressLine };
  // On a phone the count (and a close to finish) is in the cart view, so it opens there even with an empty cart.
  const registerStatus = register.session?.status;
  useEffect(() => { if (phone && (registerStatus === 'counting' || registerStatus === 'closed')) setCartOpen(true); }, [phone, registerStatus]);
  const [gateFocus, setGateFocus] = useState(0);
  const gateFocusHandled = useRef(0);
  const registerBar = (className?: string) => <TillRegisterBar online={online} onOpenPanel={() => setPanelOpen(true)}
    onGate={() => { if (phone) setCartOpen(true); setGateFocus((count) => count + 1); }} className={className} />;
  const productSettingsButton = <ProductSettingsButton viewState={viewState} onViewStateChange={onViewStateChange}
    showOutOfStock={!filters.inStock} onShowOutOfStockChange={(show) => setFilters({ ...filters, inStock: !show })}
    settings={productSettings} save={saveProductSettings} reset={resetProductSettings} phone={phone} />;
  const catalogue = <View className="flex-1">
    <PriceCheckBanner />
    {/* minCodeLength: below the till's minimum scan length, Enter in the search stays a search (ADR 0016). */}
    {/* statusAccessory: on a phone the register bar ends the status line (ADR 0017). */}
    {/* showViewToggle: a phone stays on the grid, a table is unreadable at 360 wide; the view is kept per store on this device. */}
    {/* The In Stock chip starts off so products that sell out mid-shift stay on the till. */}
    <Catalogue products={sorted} traits={traits} currency={pricing.currency} lastSyncedAt={lastSyncedAt}
      lastStockCheckAt={lastStockCheckAt} hour12={hour12} minCodeLength={scannerSettings.minChars}
      onSelect={add} statusText={statusText} statusAccessory={phone
        ? <View className="flex-row items-center gap-2">{registerBar(IN_ROW)}{productSettingsButton}</View> : productSettingsButton}
      showViewToggle={!phone} showCategoryNav
      showFilterBar filters={filters} onFiltersChange={setFilters}
      viewState={viewState} onStateChange={onViewStateChange} variationsStyle={productSettings.variations}
      onViewStateError={onViewStateError} />
    <SyncStatus state={outboxState} registerState={registerOutbox.state} pullNotice={pullNotice} pluginName={PLUGIN_NAME} />
  </View>;
  const openOrdersRow = <View className="flex-row items-stretch">
    {parked.length > 0 && <Pressable testID="parked-sales-chip" accessibilityRole="button"
      accessibilityLabel={`Parked sales (${parked.length})`} onPress={() => setParkedOpen(true)}
      className="h-14 justify-center border-t border-r border-border bg-card px-3">
      <Text className="font-medium text-foreground tabular-nums">{parked.length} ▴</Text>
    </Pressable>}
    <View className="min-w-0 flex-1">
      <OpenSaleTabs sales={openSales(sale.order, parked)} currency={pricing.currency}
        onSelect={(id) => switchTo(id)} onNew={() => switchTo(null)} />
    </View>
  </View>;
  // The register's picker or open card above the cart, the cart still usable below it (ADR 0017).
  const cart = <RegisterGate currency={pricing.currency} online={online} refused={refused} cartEmpty={!sale.order.lineItems.length} focus={{ key: gateFocus, handled: gateFocusHandled }}>
    {cartSettings.settings.openOrders === 'top' && openOrdersRow}
    <View className="flex-row items-center justify-end gap-4 px-3">
      {connector.searchCustomers && <Pressable accessibilityRole="button" onPress={() => setCustomerOpen(true)}
        className="min-h-11 justify-center">
        <Text className="text-foreground">Customer: {sale.order.customer?.name ?? 'Guest'}</Text>
      </Pressable>}
      <CartAddMenu sale={cartSale} />
      <CartSettingsButton {...cartSettings} />
    </View>
    {/* Medusa keeps the note in the order's metadata.tally_note, seen only in Admin, so it is an order note (ADR 0024). */}
    <CartNoteInput key={sale.order.id} label="Order note" value={sale.order.note ?? ''}
      onChangeText={(text) => sale.setNote(clampNote(text))} />
    <Cart sale={cartSale} orderActions={false} taxLabel={taxLabel} canEditPrice lineEditor="popover" checkout={checkout}
      quickDiscounts={cartSettings.settings.quickDiscounts}
      afterSubtotal={couponsEnabled(session.capabilities) ? <CouponField key={sale.order.id} sale={cartSale} /> : undefined}
      couponDiscountMinor={couponDiscountMinor(sale.order)}
      onPriceChange={(change) => saleLogger.info('Price changed', change)} />
    {cartSettings.settings.openOrders === 'bottom' && openOrdersRow}
    {switchRefusal ? <Text testID="open-sale-refusal" accessibilityRole="alert" className="px-3 py-1 text-destructive">{switchRefusal}</Text> : null}
    {voidOpen && <AlertDialog open onOpenChange={(next) => { if (!next) setVoidOpen(false); }}>
      <AlertDialogContent testID="cart-void-dialog">
        <AlertDialogHeader><AlertDialogTitle>Void this sale?</AlertDialogTitle></AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel asChild onPress={() => setVoidOpen(false)}>
            <Button variant="outline" testID="cart-void-keep"><UiText>Cancel</UiText></Button>
          </AlertDialogCancel>
          <AlertDialogAction asChild onPress={() => { setVoidOpen(false); sale.newSale(); }}>
            <Button variant="destructive" testID="cart-void-confirm"><UiText>Void</UiText></Button>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>}
  </RegisterGate>;

  const paid = sale.stage.kind === 'receipt' ? sale.stage.posOrder : undefined;
  return (
    <ConnectorProvider connector={connector} traitContext={traitContext}>
      <Stack.Screen options={{
        // v2's phone tender is "Checkout Order" with a close; MedusaPOS has no order number before payment, so the title carries none.
        title: phone && sale.stage.kind === 'tender' ? 'Checkout Order' : phone && cartOpen ? 'Cart' : 'Sale', headerShown: sale.stage.kind !== 'receipt',
        // Orders, Reports and Settings are in the app frame (the rail, or on a phone the drawer this button opens).
        headerLeft: () => phone && sale.stage.kind === 'tender' ? null : <FrameMenuButton />, headerRight: () => (
        // pr-4 mirrors the title's own left inset (Header.js's marginHorizontal: 16); min-h-11 keeps each a 44 px target.
        <View dataSet={{ print: 'hide' }} className="flex-row items-center gap-4 pr-4">
        <Pressable testID="user-menu" accessibilityRole="button" accessibilityLabel={`Account: ${displayName}`}
          onPress={() => setUserSheetOpen(true)} className="min-h-11 flex-row items-center gap-2">
          <View className="h-10 w-10 items-center justify-center rounded-full bg-muted"><Text className="text-foreground">{initials}</Text></View>
          {!phone && <Text className="text-foreground">{displayName}</Text>}
        </Pressable>
        {phone && sale.stage.kind === 'tender' && <IconButton testID="tender-close" accessibilityLabel="Close" className="h-11 w-11"
          disabled={sale.saving} onPress={() => { sale.cancelTender(); setCartOpen(true); }}>
          <View className="text-foreground"><XIcon size={24} /></View>
        </IconButton>}
        </View>
      ) }} />
      {/* Under the header, and above the receipt (which hides the header), so it never widens the header at 360 px. */}
      {sale.stage.kind !== 'receipt' && !phone ? registerBar() : null}
      <RegisterPanelSheet currency={pricing.currency} store={receiptStore} online={online} open={panelOpen && sale.stage.kind !== 'receipt'} onOpenChange={setPanelOpen} />
      <UserSheet session={session} displayName={displayName} initials={initials} storeName={receiptStore.name} currency={pricing.currency}
        outbox={summarizeOutboxHealth(outboxState, registerOutbox.state)} parkedSales={parked.length} paidMinor={capturedMinor(sale.order.payments)}
        open={userSheetOpen && sale.stage.kind !== 'receipt'} onOpenChange={setUserSheetOpen} onRegister={() => setPanelOpen(true)}
        signOut={signOut} signOutLocked={signOutLocked} lockMessage={lockMessage} />
      <RegisterClosedSheet currency={pricing.currency} store={receiptStore} />
      <ParkedSales sale={sale} parked={parked} onDiscard={discard} currency={pricing.currency}
        open={parkedOpen} onOpenChange={setParkedOpen} hour12={hour12} />
      {connector.searchCustomers && <Dialog open={customerOpen} onOpenChange={setCustomerOpen}>
        <DialogContent testID="customer-dialog"><DialogTitle>Customer</DialogTitle>
          <ScrollView><CustomerPicker selected={sale.order.customer} online={online}
            search={(q) => connector.searchCustomers!(syncContext, q)}
            create={(input) => connector.createCustomer!(syncContext, input)}
            onSelect={(c) => { sale.setCustomer(c ? { id: c.id, name: c.name, ...(c.email ? { email: c.email } : {}) } : null); if (c) setCustomerOpen(false); }}
            onError={(error) => { if (error instanceof ConnectorUnauthorizedError && error.code === 'unauthorized') onUnauthorized(); }} />
          </ScrollView>
        </DialogContent>
      </Dialog>}
      <EarlierSaleNote saving={sale.saving} receipt={sale.stage.kind === 'receipt'} />
      {sale.stage.kind === 'receipt' ? <>
        {/* v2 leads the paid screen with the change; screen only, not printed. */}
        {sale.stage.order.changeDueMinor > 0 && <View dataSet={{ print: 'hide' }} style={{ paddingTop: topInset + 16 }} className="w-full max-w-md self-center px-4">
          <ChangeDisplay testID="paid-change-due" change={{ amount: sale.stage.order.changeDueMinor, currency: sale.stage.order.currency }} />
        </View>}
        <Receipt order={sale.stage.order} posOrder={sale.stage.posOrder}
        store={receiptStore}
        footerSlot={connector.emailReceipt ? <EmailReceipt
          orderId={recent.find(order => order.id === paid?.id)?.serverRefs?.orderId}
          online={online} defaultEmail={paid?.customer?.email}
          send={(orderId, email) => connector.emailReceipt!(syncContext, orderId, email)} onUnauthorized={onUnauthorized} /> : undefined}
        topInset={sale.stage.order.changeDueMinor > 0 ? 0 : topInset} formatDate={formatDate} taxLabel={taxLabel}
        cashier={session.name || session.email} registerId={registerId} newSale={sale.newSale} /></> :
        <View dataSet={{ print: 'hide' }} className="flex-1 bg-background">
          {settingsStatus ? <Text className="text-destructive">{settingsStatus}</Text> : null}
          {/* Only while idle: new settings never land mid-sale (useSale also holds them until then). */}
          {onRetry && sale.idle ? <Pressable accessibilityRole="button" onPress={onRetry}><Text className="text-foreground underline">Retry</Text></Pressable> : null}
          {/* v2's Panel position; the column and phone layouts ignore it. */}
          {!phone ? <View testID="till-panels" className="flex-1"
            style={{ flexDirection: width >= ROW_BREAKPOINT ? (cartSettings.settings.cartSide === 'left' ? 'row-reverse' : 'row') : 'column' }}>
            {catalogue}
            <View className="flex-1 border-t border-border bg-card">
              {sale.stage.kind === 'cart' ? cart : tenderPane}
            </View>
          </View> : sale.stage.kind === 'tender' ? <View className="flex-1 bg-card">{tenderPane}</View>
            : cartOpen ? <View className="flex-1 bg-card">
              <View className="flex-row items-center justify-between border-b border-border pr-3">
                <Pressable accessibilityRole="button" accessibilityLabel="Products" onPress={() => setCartOpen(false)}
                  className="min-h-11 self-start justify-center px-3"><Text className="text-primary">‹ Products</Text></Pressable>
                {registerBar(IN_ROW)}
              </View>
              {scanMiss ? <Text accessibilityRole="alert" className="px-3 py-2 text-destructive">{`No product matches "${scanMiss}"`}</Text> : null}
              {cart}
            </View> : <>{catalogue}<CartBar sale={sale} onOpen={() => setCartOpen(true)} /></>}
        </View>}
    </ConnectorProvider>
  );
}
