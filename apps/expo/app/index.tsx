import { useCallback, useEffect, useMemo, useRef, useState, useContext } from 'react';
import { Pressable, ScrollView, View, useWindowDimensions } from 'react-native';
import { AppText as Text } from '../components/app-text';
import { Redirect, router, Stack, usePathname } from 'expo-router';
import { getCalendars } from 'expo-localization';

import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, Button, Cart,
  Catalogue, CustomerPicker, Dialog, DialogContent, DialogTitle, IconButton, Receipt, SyncStatus, Tender, Text as UiText, XIcon,
  DEFAULT_PRODUCT_FILTERS, type ProductFilters,
} from '@tallyui/components';
import { ConnectorProvider, ConnectorUnauthorizedError, resolvePrice } from '@tallyui/core';
import {
  capturedMinor, catalogueEntries, findEntryByCode, getDeviceId, needsAttention, openSales, saleLogger, SALE_SAVING, summarizeOutboxHealth, useParkedSales, useSale,
  normalizeCatalogueViewState, type CatalogueViewState,
} from '@tallyui/pos';

import { AccountButton } from '../components/account-button';
import { FrameMenuButton, useFrameAccountPublisher, useFrameBadge } from '../components/app-frame';
import { CartAddMenu } from '../components/cart-add-menu';
import { CartNoteLink, CartNoteRow, CartNoteSheet } from '../components/cart-note';
import { CartSettingsButton } from '../components/cart-settings';
import { CatalogueSyncButton } from '../components/catalogue-sync-button';
import { CouponField, couponDiscountMinor, couponsEnabled } from '../components/coupon-field';
import { CustomerAddressDialog } from '../components/customer-address-dialog';
import { CustomerChip } from '../components/customer-chip';
import { CustomerSavedToast, useCustomerSavedToast } from '../components/customer-saved-toast';
import { NewCustomerDialog } from '../components/new-customer-dialog';
import { OfflineToast, useOfflineToast } from '../components/offline-toast';
import { OpenOrdersList, OpenOrdersStrip } from '../components/open-orders';
import { ScanToast, scanAddedDescription, useScanToast } from '../components/scan-toast';
import { EarlierSaleNote, EARLIER_SALE_SAVING } from '../components/earlier-sale-note';
import { EmailReceipt } from '../components/email-receipt';
import { PaidAwaiting, useAwaitingStore } from '../components/paid-awaiting';
import { PaidChange } from '../components/paid-change';
import { PaidSummary } from '../components/paid-summary';
import { PhoneTabBar } from '../components/phone-tab-bar';
import { storeRegisterTitle } from '../lib/store-register-title';
import { HeaderRegisterState, WideHeaderRegister, wideRegisterState } from '../components/header-register-state';
import { PriceCheckBanner } from '../components/price-check-banner';
import { ProductSettingsButton } from '../components/product-settings';
import {
  GETTING_READY, RegisterClosedSheet, RegisterGate, RegisterPanelSheet, useGatedSale,
} from '../components/register';
import { StripHeightContext } from '../components/store-refused';
import { StoreSettingsGate, type TillCatalogueLeafProps } from '../components/till-catalogue-gate';
import { TenderOrderSummary } from '../components/tender-order-summary';
import { UserSheet } from '../components/user-sheet';
import { loadCatalogueView, saveCatalogueView, withCatalogueSort } from '../lib/catalogue-view';
import { TILL_PAYMENT_METHODS } from '../lib/card-payments';
import { sortCartLines, useCartSettings } from '../lib/cart-settings';
import { catalogueStatus, publishCatalogue, sellableCatalogue, withdrawCatalogue } from '../lib/catalogue-snapshot';
import { createMedusaDiscountCodes } from '../lib/coupons';
import { loadCustomerAddresses } from '../lib/customer-billing';
import { isDemoAccount } from '../lib/demo';
import { clampNote } from '../lib/note-text';
import { withDemoSaleEvent } from '../lib/demo-analytics';
import { formatPaidDate, formatReceiptDate } from '../lib/format-date';
import { markBusy } from '../lib/live-tab';
import { draftsCollection } from '../lib/order-store';
import { receiptTaxLabel } from '../lib/order-detail';
import { useOutboxContext } from '../lib/outbox-context';
import { usePrintingSettings, useAutoPrintReceipt } from '../lib/printing-settings';
import { useProductSettings } from '../lib/product-settings';
import { useRegister } from '../lib/register-context';
import { useScannerSettings } from '../lib/scanner-settings';
import { playScanBeep } from '../lib/scan-beep';
import { forgetDeletedDefaultCustomer, useDefaultCustomer } from '../lib/default-customer';
import { forgetDeletedCashierCustomer, useCashierCustomer } from '../lib/cashier-customer';
import { defaultStorage, REGISTER_ID_KEY } from '../lib/session';
import { useSession } from '../lib/session-context';
import { useReplicatedProducts, type SyncState } from '../lib/use-replicated-products';
import { useDeviceScans } from '../lib/use-device-scans';
import { useNetworkOnline } from '../lib/use-network-online';
import { useEscapeBack } from '../lib/use-escape-back';
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

// ADR 0009: phone mode below 600 px.
const PHONE_BREAKPOINT = 600;
// ADR 0009: from 600 px, products and cart stack in a column below 900 px and sit in a row from 900 px.
const ROW_BREAKPOINT = 900;

// The rate arrives in parts per million (10 000 ppm = 1%).
const taxLabel = receiptTaxLabel;

export default function ProductsScreen() {
  const { session, signOut, reportUnauthorized, reportNoPosAccess, mergeCapabilities } = useSession();
  const lastEmail = useRef<string | undefined>(undefined);
  if (!session) return <Redirect href={isDemoAccount(lastEmail.current ?? '') ? '/demo' : '/login'} />;
  lastEmail.current = session.email;
  return <StoreSettingsGate key={session.baseUrl} session={session} signOut={signOut} onUnauthorized={reportUnauthorized}
    onNoPosAccess={reportNoPosAccess} onCapabilities={mergeCapabilities} Leaf={SignedInProducts} />;
}

function SignedInProducts({ session, signOut, onUnauthorized, settings, settingsStatus, pricing, syncContext, onRetry, onBusy, connector }: TillCatalogueLeafProps) {
  const traits = connector.traits.product;
  const { setSaleHold } = useSession();
  const {
    products, state, error, lastSyncedAt, stockOverlay, lastStockCheckAt, reconcileStock, unlisted, pullNotice, resumePull, syncNow,
    clearAndRefresh,
  } = useReplicatedProducts(connector, syncContext, onUnauthorized);
  // v2's header "● Offline": the browser losing the network shows offline at once, not only after a pull fails.
  const networkOnline = useNetworkOnline();
  const pullState: SyncState = networkOnline ? state : 'offline';
  const offline = useOfflineToast(networkOnline, state);
  const online = pullState !== 'offline';
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
  const { register, registerOutbox, boundRegisterId, registerName } = useRegister();
  // v2 dims the product side during the count (row 09e).
  const counting = register.session?.status === 'counting' || register.closing;
  const drafts = draftsCollection(orders);
  const { parked } = useParkedSales(drafts);
  const [ordersListOpen, setOrdersListOpen] = useState(false);
  const [switchRefusal, setSwitchRefusal] = useState<string | null>(null);
  const switchTo = (id: string | null) => { void sale.switchSale(id).then(setSwitchRefusal); };
  const [customerOpen, setCustomerOpen] = useState(false);
  const [newCustomerOpen, setNewCustomerOpen] = useState(false);
  const [addressCustomerId, setAddressCustomerId] = useState<string | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [filters, setFilters] = useState<ProductFilters>({ ...DEFAULT_PRODUCT_FILTERS, inStock: false });
  // Clear and Refresh (v2): the search is Catalogue's own state, so a new key empties it; the filters go back to the start.
  const [catalogueKey, setCatalogueKey] = useState(0);
  // Stable, so the published snapshot (the Products area's sync arrow) does not change every render.
  const clearCatalogue = useCallback(() => {
    clearAndRefresh();
    setFilters({ ...DEFAULT_PRODUCT_FILTERS, inStock: false });
    setCatalogueKey((key) => key + 1);
  }, [clearAndRefresh]);
  const entriesRef = useRef<ReturnType<typeof catalogueEntries>>([]);
  const token = useRef(session.token);
  token.current = session.token;
  const discountCodes = useMemo(() => createMedusaDiscountCodes({ baseUrl: session.baseUrl, token: () => token.current }), [session.baseUrl]);
  const { customer: savedDefaultCustomer } = useDefaultCustomer(defaultStorage(), session.baseUrl);
  // v2's "Default customer is cashier": the Medusa customer with the signed-in admin's email, else the picked default.
  const cashierSearch = useMemo(() => connector.searchCustomers
    ? (q: string) => connector.searchCustomers!(syncContext, q) : undefined, [connector, syncContext]);
  const { customer: cashierCustomer } = useCashierCustomer(defaultStorage(), session, cashierSearch,
    (error) => { if (error instanceof ConnectorUnauthorizedError && error.code === 'unauthorized') onUnauthorized(); });
  const defaultCustomer = cashierCustomer ?? savedDefaultCustomer;
  // The default's stored email stays off the order payload; the paid screen's receipt prefill reads it from storage.
  const saleDefaultCustomer = useMemo(() => defaultCustomer ? { id: defaultCustomer.id, name: defaultCustomer.name } : null, [defaultCustomer]);
  useEffect(() => {
    // The store no longer has this customer: useSale falls back to Guest on an idle cart or the next sale; an open sale keeps its customer.
    for (const order of recent) {
      forgetDeletedDefaultCustomer(defaultStorage(), session.baseUrl, order.warnings);
      forgetDeletedCashierCustomer(defaultStorage(), session.baseUrl, session.email, order.warnings);
    }
  }, [recent, session.baseUrl, session.email]);
  const sale = useSale(pricing, { defaultCustomer: saleDefaultCustomer, registerId, cashierRef: session.email, capabilities: session.capabilities, onSaleCompleted: isDemoAccount(session.email) ? withDemoSaleEvent(record) : record,
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
  // Returns sale.add's result (a scan's toast reads it), or undefined while counting.
  const add = (entry: Parameters<typeof sale.add>[0]) => { if (counting) return undefined; onBusy(true); return sale.add(entry, traits); };
  useEffect(() => {
    markBusy('payment', sale.stage.kind === 'tender');
    return () => markBusy('payment', false);
  }, [sale.stage.kind]);
  const { width } = useWindowDimensions();
  // Phone mode (ADR 0009): products or the cart at full height, the tender over both; a new sale starts on products.
  const phone = width < PHONE_BREAKPOINT;
  const dimmed = counting && !phone;
  const [viewState, setViewState] = useState(() => withCatalogueSort(normalizeCatalogueViewState({
    ...loadCatalogueView(defaultStorage(), session.baseUrl), ...(phone ? { view: 'grid' } : {}),
  })));
  const { settings: productSettings, save: saveProductSettings, reset: resetProductSettings } = useProductSettings(defaultStorage(), session.baseUrl);
  const onViewStateError = (error: unknown) => console.warn('Could not load or save the catalogue view:', error);
  const onViewStateChange = (change: CatalogueViewState) => {
    const next = withCatalogueSort(change);
    setViewState(next);
    try { saveCatalogueView(defaultStorage(), session.baseUrl, next); } catch (error) { onViewStateError(error); }
  };
  const [cartOpen, setCartOpen] = useState(false);
  useEffect(() => { if (sale.stage.kind === 'receipt') setCartOpen(false); }, [sale.stage.kind]);
  // v2's checkout is a modal over the cart: the chip and its address pin exist only in the cart stage, and so do the
  // customer picker, the new-customer dialog, the address dialog and the note dialog, so leaving the cart closes them and a cancelled
  // tender does not reopen them.
  useEffect(() => {
    if (sale.stage.kind !== 'cart') { setAddressCustomerId(null); setCustomerOpen(false); setNewCustomerOpen(false); setNoteOpen(false); }
  }, [sale.stage.kind]);
  // Read at pick time: the picker's New customer create can settle after its dialog closed, and that late pick is dropped.
  const pickerLive = useRef(false);
  pickerLive.current = customerOpen && sale.stage.kind === 'cart';
  const traitContext = useMemo(() => ({ currency: pricing.currency }), [pricing.currency]);

  // Reconciled stock over replicated stock, for everything the catalogue shows (ADR-060).
  const sorted = useMemo(() => sellableCatalogue(products, connector, stockOverlay), [products, stockOverlay]);
  const entries = useMemo(() => catalogueEntries(sorted, traits), [sorted]);
  entriesRef.current = entries;
  // The Products area reads this catalogue; it stays live while the area is pushed over the Sale.
  const catalogueState = catalogueStatus(products.length, state);
  const catalogueSyncing = pullState === 'syncing' || pullState === 'connecting';
  useEffect(() => {
    publishCatalogue({ owner: 'sale', baseUrl: session.baseUrl, products: sorted, traits, currency: pricing.currency,
      status: catalogueState, error: error ?? undefined, sync: syncNow, clearAndRefresh: clearCatalogue, syncing: catalogueSyncing });
  }, [session.baseUrl, sorted, traits, pricing.currency, catalogueState, error, syncNow, clearCatalogue, catalogueSyncing]);
  useEffect(() => () => withdrawCatalogue('sale'), []);
  const scanToast = useScanToast();
  const clearScanToast = scanToast.clear;
  // v2's scan toasts belong to the cart stage: leaving it (tender, receipt) hides the current one.
  useEffect(() => { if (sale.stage.kind !== 'cart') clearScanToast(); }, [sale.stage.kind, clearScanToast]);
  // v2's "<name> saved" after the cart's Add Customer, the Customers screen's own message; it too belongs to the cart stage.
  const customerSaved = useCustomerSavedToast();
  const clearCustomerSaved = customerSaved.clear;
  useEffect(() => { if (sale.stage.kind !== 'cart') clearCustomerSaved(); }, [sale.stage.kind, clearCustomerSaved]);
  const pathname = usePathname();
  // v2 scans anywhere in the POS; an editable target (search box, coupon field) keeps its own input, so no double add; off while an area is over the Sale and in tender.
  // Every layout listens in the cart stage, the phone's Products and Cart views alike.
  const wedgeActive = sale.stage.kind === 'cart' && pathname === '/';
  const { settings: scannerSettings } = useScannerSettings(defaultStorage(), session.baseUrl);
  const { settings: printingSettings } = usePrintingSettings(defaultStorage(), session.baseUrl);
  const cartSettings = useCartSettings(defaultStorage(), session.baseUrl);
  // Sort items (Cart Settings) is display order only: Cart gets a re-ordered copy, the sale's stored order is untouched.
  const sortedCartSale = useMemo(() => {
    const lines = sortCartLines(cartSale.order.lineItems, cartSettings.settings.sortItems);
    // A sorted result is always a fresh copy, so Cart may have it as its (mutable) LineItem[].
    return lines === cartSale.order.lineItems ? cartSale
      : { ...cartSale, order: { ...cartSale.order, lineItems: lines as typeof cartSale.order.lineItems } };
  }, [cartSale, cartSettings.settings.sortItems]);
  // v2's auto-print: the paid screen prints each finished sale's receipt once, never a reprint from Orders.
  // v2's "Automatically show receipt after checkout" off skips the paid screen; an auto-print still prints from it first.
  useAutoPrintReceipt(sale.stage.kind === 'receipt' ? sale.stage.order.id : undefined, printingSettings.autoPrintReceipt,
    undefined, cartSettings.settings.autoShowReceipt ? undefined : sale.newSale);
  const onScan = (code: string) => {
    if (scannerSettings.playSound) playScanBeep();
    const entry = findEntryByCode(entries, code);
    if (!entry) { scanToast.show({ kind: 'not-found', code }); return; }
    const added = add(entry);
    if (typeof added === 'object') scanToast.show({ kind: 'added',
      description: scanAddedDescription(traits.getName(entry.product), entry.variant, traits.getVariants?.(entry.product).length ?? 1) });
    else scanToast.clear();
  };
  useWedgeScan(wedgeActive, scannerSettings, onScan);
  // A directly connected scanner (Settings > Scanner) types nothing, so it adds in every layout without a double add.
  useDeviceScans(sale.stage.kind === 'cart', onScan);
  // v2: on web, Escape in the tender does what its ✕ / Back does (not while saving, as the ✕ is disabled).
  useEscapeBack(sale.stage.kind === 'tender', () => { if (sale.saving) return; sale.cancelTender(); if (phone) setCartOpen(true); });
  const sellableCount = sorted.length;
  // On a phone the status line shares one line with the product settings button, so it drops the store name and
  // the unlisted count, and puts an error before the count, where the ellipsis leaves it.
  const productCount = `${sellableCount.toLocaleString()} ${sellableCount === 1 ? 'product' : 'products'}`;
  const storeName = settings.storeName.trim() ? settings.storeName : connector.name;
  const statusText = phone ? `${STATE_LABEL[pullState]}${error ? ` · ${error}` : ''} · ${productCount}`
    : `${storeName} · ${STATE_LABEL[pullState]} · ${productCount}`
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
    : <Tender sale={sale} methods={TILL_PAYMENT_METHODS} />;
  // The register control (ADR 0017): the header state brings up the gate (on a phone, the cart view, even with an empty
  // cart), or the panel while the session is open.
  const [panelOpen, setPanelOpen] = useState(false);
  const [userSheetOpen, setUserSheetOpen] = useState(false);
  const displayName = session.name || session.email;
  const initials = (session.name ? session.name.trim().split(/\s+/).slice(0, 2).map((word) => word[0]).join('') : session.email[0]).toUpperCase();
  // Every area's avatar opens this sheet (row 14a): opened from an area it, and its register panel, show over the
  // area whatever the sale's stage, and Switch register goes back to the sale before the picker.
  const [sheetFromArea, setSheetFromArea] = useState(false);
  useFrameAccountPublisher({ displayName, initials, open: () => { setSheetFromArea(true); setUserSheetOpen(true); } });
  // The receipt's and the last closure's store (ADR 0018).
  const receiptStore = { name: settings.storeName, address: settings.location.addressLine };
  // On a phone the count (and a close to finish) is in the cart view, so it opens there even with an empty cart.
  const registerStatus = register.session?.status;
  useEffect(() => { if (phone && (registerStatus === 'counting' || registerStatus === 'closed')) setCartOpen(true); }, [phone, registerStatus]);
  const [gateFocus, setGateFocus] = useState(0);
  const gateFocusHandled = useRef(0);
  const openGate = () => { if (phone) setCartOpen(true); setGateFocus((count) => count + 1); };
  // v2's phone has no register row (row 17a): every state the wide header names shows in the phone header instead.
  const headerRegisterState = phone && sale.stage.kind !== 'tender' ? wideRegisterState(boundRegisterId, online, register) : null;
  const productSettingsButton = <ProductSettingsButton viewState={viewState} onViewStateChange={onViewStateChange}
    showOutOfStock={!filters.inStock} onShowOutOfStockChange={(show) => setFilters({ ...filters, inStock: !show })}
    settings={productSettings} save={saveProductSettings} reset={resetProductSettings} phone={phone} />;
  // v2's sync arrow sits right after the count, before the product settings.
  const statusAccessory = <View className="flex-row items-center">
    <CatalogueSyncButton onSync={syncNow} onClearAndRefresh={clearCatalogue} syncing={pullState === 'syncing' || pullState === 'connecting'} />
    {productSettingsButton}
  </View>;
  const catalogue = <View className="flex-1">
    <PriceCheckBanner />
    {/* minCodeLength: below the till's minimum scan length, Enter in the search stays a search (ADR 0016). */}
    {/* showViewToggle: a phone stays on the grid, a table is unreadable at 360 wide; the view is kept per store on this device. */}
    {/* The In Stock chip starts off so products that sell out mid-shift stay on the till. */}
    <View testID="catalogue-area" className="flex-1" pointerEvents={dimmed ? 'none' : 'auto'}
      aria-disabled={dimmed} style={{ opacity: dimmed ? 0.5 : 1 }}>
    <Catalogue key={catalogueKey} products={sorted} traits={traits} currency={pricing.currency} lastSyncedAt={lastSyncedAt}
      lastStockCheckAt={lastStockCheckAt} hour12={hour12} minCodeLength={scannerSettings.minChars}
      onSelect={add} statusText={statusText} statusAccessory={statusAccessory}
      showViewToggle={!phone} showCategoryNav
      showFilterBar filters={filters} onFiltersChange={setFilters}
      viewState={viewState} onStateChange={onViewStateChange} variationsStyle={productSettings.variations}
      onViewStateError={onViewStateError} />
    </View>
    <SyncStatus state={outboxState} registerState={registerOutbox.state} pullNotice={pullNotice} pluginName={PLUGIN_NAME} />
  </View>;
  // The till's open sales: the strip's tabs, and the count's "carts still open" line (row 09e.2).
  const tillSales = openSales(sale.order, parked);
  const openOrdersRow = <OpenOrdersStrip sales={tillSales} currency={pricing.currency} listOpen={ordersListOpen}
    onListOpenChange={setOrdersListOpen} onSelect={(id) => switchTo(id)} onNew={() => { setOrdersListOpen(false); switchTo(null); }} />;
  // v2's note row sits in the totals, nearest Checkout; an empty cart draws no totals, so it takes the link's place.
  const noteSet = (sale.order.note ?? '').trim() !== '';
  const hasLines = sale.order.lineItems.length > 0;
  const noteInTotals = noteSet && hasLines;
  const noteRow = <CartNoteRow note={sale.order.note ?? ''} onPress={() => setNoteOpen(true)} />;
  const couponField = couponsEnabled(session.capabilities) ? <CouponField key={sale.order.id} sale={cartSale} /> : null;
  // The register's picker or open card above the cart, the cart still usable below it (ADR 0017).
  const cart = <RegisterGate currency={pricing.currency} online={online} refused={refused} cartEmpty={!sale.order.lineItems.length} openSaleCount={tillSales.length} focus={{ key: gateFocus, handled: gateFocusHandled }}>
    {cartSettings.settings.openOrders === 'top' && openOrdersRow}
    {/* v2's Open orders list takes the cart's place beside the strip. */}
    {ordersListOpen ? <OpenOrdersList sales={tillSales} currency={pricing.currency}
      onSelect={(id) => { setOrdersListOpen(false); switchTo(id); }} onClose={() => setOrdersListOpen(false)} /> : <>
    <View className="flex-row items-center justify-end gap-4 px-3">
      {connector.searchCustomers && <CustomerChip name={sale.order.customer?.name} onPress={() => setCustomerOpen(true)}
        onAddress={sale.order.customer && online && connector.getCustomer && connector.updateCustomer
          ? () => setAddressCustomerId(sale.order.customer?.id ?? null) : undefined} />}
      <CartAddMenu sale={cartSale} onAddCustomer={connector.createCustomer && online ? () => setNewCustomerOpen(true) : undefined} />
      <CartSettingsButton {...cartSettings} phone={phone} />
    </View>
    {/* Medusa keeps the note in the order's metadata.tally_note, seen only in Admin, so it is an order note (ADR 0024). */}
    {!noteSet ? <CartNoteLink onPress={() => setNoteOpen(true)} /> : !hasLines && <View className="px-3">{noteRow}</View>}
    {/* v2's cart has no Total row: the total is on the Checkout button. */}
    <Cart sale={sortedCartSale} orderActions={false} showTotal={false} taxLabel={taxLabel} canEditPrice lineEditor="popover" checkout={checkout}
      quickDiscounts={cartSettings.settings.quickDiscounts} columns={cartSettings.settings.columns}
      afterSubtotal={couponField || noteInTotals ? <>{couponField}{noteInTotals && noteRow}</> : undefined}
      couponDiscountMinor={couponDiscountMinor(sale.order)}
      onPriceChange={(change) => saleLogger.info('Price changed', change)} />
    </>}
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
  // v2's "Awaiting store" headline while the paid sale's outbox entry is unsent (offline, or a send failed).
  const awaiting = useAwaitingStore(recent.find(order => order.id === paid?.id), online, outboxState);
  const wide = width >= ROW_BREAKPOINT;
  const paidHeadline = sale.stage.kind === 'receipt' && (awaiting || sale.stage.order.changeDueMinor > 0);
  const paidReceipt = sale.stage.kind === 'receipt' ? <>
    {/* v2 leads the paid screen with the change, or an unsent sale with "Awaiting store"; screen only, not printed. */}
    {paidHeadline && <View dataSet={{ print: 'hide' }} style={{ paddingTop: topInset + 16 }} className="w-full max-w-md self-center px-4">
      {awaiting ? <PaidAwaiting order={sale.stage.order} posOrder={sale.stage.posOrder} />
        : <PaidChange order={sale.stage.order} posOrder={sale.stage.posOrder} />}
    </View>}
    <Receipt order={sale.stage.order} posOrder={sale.stage.posOrder}
    store={receiptStore}
    footerSlot={connector.emailReceipt ? <EmailReceipt
      orderId={recent.find(order => order.id === paid?.id)?.serverRefs?.orderId}
      online={online} defaultEmail={paid?.customer?.email
        ?? (paid?.customer && paid.customer.id === defaultCustomer?.id ? defaultCustomer?.email : undefined)}
      send={(orderId, email, saveToBilling) => connector.emailReceipt!(syncContext, orderId, email, { saveToBilling })} onUnauthorized={onUnauthorized} /> : undefined}
    topInset={paidHeadline ? 0 : topInset} formatDate={formatReceiptDate} taxLabel={taxLabel}
    cashier={session.name || session.email} registerId={registerId} newSale={sale.newSale} />
  </> : null;
  const phoneTender = phone && sale.stage.kind === 'tender';
  const offlineShown = offline.kind !== null && sale.stage.kind === 'cart' && (!phone || !cartOpen);
  const scanToastShown = scanToast.toast !== null && sale.stage.kind === 'cart';
  const customerSavedShown = customerSaved.name !== null && sale.stage.kind === 'cart';
  return (
    <ConnectorProvider connector={connector} traitContext={traitContext}>
      <Stack.Screen options={{
        // The title names the store and register as v2's title bar does, and on a phone as v2's phone header does on
        // Products and Cart alike; the phone tender's header, as v2's, carries only "Checkout Order" and a close.
        title: phoneTender ? 'Checkout Order' : storeRegisterTitle(storeName, boundRegisterId, registerName), headerShown: sale.stage.kind !== 'receipt',
        // React Navigation sizes the title for a 52 px right button; on a phone the title shrinks to what the right controls
        // leave. native-stack's types omit these, but its web view spreads the options onto elements' Header.
        ...(phone ? { headerTitleContainerStyle: { flexShrink: 1 }, headerRightContainerStyle: { flexBasis: 'auto', flexShrink: 0 } } : {}),
        // Orders, Reports and Settings are in the app frame (the rail, or on a phone the drawer this button opens).
        headerLeft: () => phoneTender ? null : <FrameMenuButton />, headerRight: () => (
        // pr-4 mirrors the title's own left inset (Header.js's marginHorizontal: 16); min-h-11 keeps each a 44 px target.
        <View dataSet={{ print: 'hide' }} className={phone ? 'flex-row items-center gap-4 pr-4' : 'flex-1 flex-row items-center gap-4 pr-4'}>
        {!phone && <WideHeaderRegister online={online} salesToSend={outboxState.pending} onOpenPanel={() => setPanelOpen(true)} onGate={openGate} />}
        {headerRegisterState && <HeaderRegisterState label={headerRegisterState} salesToSend={outboxState.pending}
          onPress={registerStatus === 'open' ? () => setPanelOpen(true) : openGate} />}
        {!phoneTender && <AccountButton testID="user-menu" displayName={displayName} initials={initials}
          onPress={() => { setSheetFromArea(false); setUserSheetOpen(true); }} />}
        {phoneTender && <IconButton testID="tender-close" accessibilityLabel="Close" className="h-11 w-11"
          disabled={sale.saving} onPress={() => { sale.cancelTender(); setCartOpen(true); }}>
          <View className="text-foreground"><XIcon size={24} /></View>
        </IconButton>}
        </View>
      ) }} />
      <RegisterPanelSheet currency={pricing.currency} store={receiptStore} online={online} open={panelOpen && (sheetFromArea || sale.stage.kind !== 'receipt')} onOpenChange={setPanelOpen} />
      <UserSheet session={session} displayName={displayName} initials={initials} storeName={receiptStore.name} currency={pricing.currency}
        outbox={summarizeOutboxHealth(outboxState, registerOutbox.state)} parkedSales={parked.length} paidMinor={capturedMinor(sale.order.payments)}
        open={userSheetOpen && (sheetFromArea || sale.stage.kind !== 'receipt')} onOpenChange={setUserSheetOpen} onRegister={() => setPanelOpen(true)}
        onChooseRegister={sheetFromArea ? () => { router.dismissTo('/'); openGate(); } : openGate}
        signOut={signOut} signOutLocked={signOutLocked} lockMessage={lockMessage} />
      <RegisterClosedSheet currency={pricing.currency} store={receiptStore} />
      {connector.searchCustomers && <Dialog open={customerOpen && sale.stage.kind === 'cart'} onOpenChange={setCustomerOpen}>
        <DialogContent testID="customer-dialog"><DialogTitle>Customer</DialogTitle>
          <ScrollView><CustomerPicker selected={sale.order.customer} online={online}
            search={(q) => connector.searchCustomers!(syncContext, q)}
            create={(input) => connector.createCustomer!(syncContext, input)}
            onSelect={(c) => { if (!pickerLive.current) return; sale.setCustomer(c ? { id: c.id, name: c.name, ...(c.email ? { email: c.email } : {}) } : null); if (c) setCustomerOpen(false); }}
            onError={(error) => { if (error instanceof ConnectorUnauthorizedError && error.code === 'unauthorized') onUnauthorized(); }} />
          </ScrollView>
        </DialogContent>
      </Dialog>}
      {connector.createCustomer && <NewCustomerDialog open={newCustomerOpen && sale.stage.kind === 'cart'} onOpenChange={setNewCustomerOpen}
        create={(input) => connector.createCustomer!(syncContext, input)}
        update={connector.updateCustomer && ((id, patch) => connector.updateCustomer!(syncContext, id, patch))}
        onSaved={(c) => sale.setCustomer({ id: c.id, name: c.name, ...(c.email ? { email: c.email } : {}) })}
        onAdded={(c) => customerSaved.show(c.name)} onUnauthorized={onUnauthorized} />}
      {connector.getCustomer && connector.updateCustomer && <CustomerAddressDialog customerId={sale.stage.kind === 'cart' ? addressCustomerId : null}
        onClose={() => setAddressCustomerId(null)} getCustomer={(id) => connector.getCustomer!(syncContext, id)}
        loadAddresses={(id) => loadCustomerAddresses(syncContext, id)}
        update={(id, patch) => connector.updateCustomer!(syncContext, id, patch)}
        onSaved={(c) => sale.setCustomer({ id: c.id, name: c.name, ...(c.email ? { email: c.email } : {}) })}
        onUnauthorized={onUnauthorized} cartSide={cartSettings.settings.cartSide} phone={phone} />}
      <CartNoteSheet open={noteOpen && sale.stage.kind === 'cart'} onOpenChange={setNoteOpen} value={sale.order.note ?? ''}
        onChangeText={(text) => sale.setNote(clampNote(text))} cartSide={cartSettings.settings.cartSide} phone={phone} />
      <EarlierSaleNote saving={sale.saving} receipt={sale.stage.kind === 'receipt'} />
      {sale.stage.kind === 'receipt' ? wide ? <View testID="paid-layout" className="flex-1 flex-row items-start">
        <View className="flex-1">{paidReceipt}</View>
        <View dataSet={{ print: 'hide' }} className="w-96 self-stretch" style={{ paddingTop: topInset }}>
          <PaidSummary order={sale.stage.order} posOrder={sale.stage.posOrder} storeName={receiptStore.name}
            taxLabel={taxLabel} formatDate={(iso) => formatPaidDate(iso)} awaiting={awaiting} />
        </View>
      </View> : paidReceipt :
        <View dataSet={{ print: 'hide' }} className="flex-1 bg-background">
          {settingsStatus ? <Text className="text-destructive">{settingsStatus}</Text> : null}
          {/* Only while idle: new settings never land mid-sale (useSale also holds them until then). */}
          {onRetry && sale.idle ? <Pressable accessibilityRole="button" onPress={onRetry}><Text className="text-foreground underline">Retry</Text></Pressable> : null}
          {/* v2's Panel position; the column and phone layouts ignore it. */}
          {!phone ? <View testID="till-panels" className="flex-1"
            style={{ flexDirection: width >= ROW_BREAKPOINT ? (cartSettings.settings.cartSide === 'left' ? 'row-reverse' : 'row') : 'column' }}>
            {/* v2: tender takes the products' side, the order summary stays beside it; phone unchanged. */}
            {sale.stage.kind === 'tender' ? <View testID="tender-slot" className="flex-1 bg-card">{tenderPane}</View> : catalogue}
            <View className="flex-1 border-t border-border bg-card">
              {sale.stage.kind === 'cart' ? cart : <TenderOrderSummary order={sale.order} taxLabel={taxLabel} />}
            </View>
          </View> : sale.stage.kind === 'tender' ? <View className="flex-1 bg-card">{tenderPane}</View>
            : <>{cartOpen ? <View className="flex-1 bg-card">
              {cart}
            </View> : catalogue}
              <PhoneTabBar active={cartOpen ? 'cart' : 'products'}
                itemCount={sale.order.lineItems.reduce((count, line) => count + line.quantity, 0)}
                onSelect={(tab) => setCartOpen(tab === 'cart')} />
            </>}
          {/* The till's one toast host, floating over the top of the screen in every layout; the empty sides stay tappable.
              v2's "Device went offline" toast shows over the products only, the scan toasts and the "<name> saved" message
              in the whole cart stage. */}
          {(offlineShown || scanToastShown || customerSavedShown) && <View pointerEvents="box-none" className="absolute inset-x-0 top-2 items-center gap-2 px-2">
            {offlineShown && <OfflineToast kind={offline.kind!} onClose={offline.close} />}
            {scanToastShown && <ScanToast toast={scanToast.toast!} />}
            {customerSavedShown && <CustomerSavedToast name={customerSaved.name!} />}
          </View>}
        </View>}
    </ConnectorProvider>
  );
}
