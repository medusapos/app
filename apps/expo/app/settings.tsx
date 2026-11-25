import { useContext, useMemo, useRef, useState, type ComponentProps } from 'react';
import { Platform, Pressable, ScrollView, TextInput, View, useWindowDimensions, type NativeSyntheticEvent, type TextInputKeyPressEventData } from 'react-native';
import { AppText as Text } from '../components/app-text';
import { Redirect, router, Stack, useLocalSearchParams } from 'expo-router';
import { Path } from 'react-native-svg';
import { Card, ChevronDownIcon, createSvgIcon, CustomerPicker, Dialog, DialogContent, DialogTitle, SettingsLayout, Switch, Text as TallyText, ToggleGroup, ToggleGroupItem } from '@tallyui/components';
import { ConnectorUnauthorizedError, type SyncContext } from '@tallyui/core';
import { ClearLocalDataSection } from '../components/clear-local-data';
import { DirectScannerConnection } from '../components/device-scanner';
import { cameraScanSupported } from '../lib/camera-scan';
import { THEME_LABELS, ThemeTiles } from '../components/theme-tiles';
import { FontPicker } from '../components/font-choice';
import { PrintersGroup } from '../components/printers-group';
import { PaymentProvidersGroup } from '../components/payment-providers-group';
import { ReceiptTemplatesGroup } from '../components/receipt-templates';
import { AreaAccountButton, FrameMenuButton, useFrameMenu } from '../components/app-frame';
import { StripHeightContext } from '../components/store-refused';
import { ExternalLinkIcon } from '../components/external-link-icon';
import { version as appVersion } from '../package.json';
import { feedbackUrl, openFeedbackUrl } from '../lib/feedback-url';
import { medusaAdminUrl, openMedusaAdmin, type MedusaAdminPage } from '../lib/medusa-admin';
import { defaultStorage, type Session } from '../lib/session';
import { useSession } from '../lib/session-context';
import { getDeviceName } from '../lib/register-context';
import { SettingsFlatContext, SettingsGroup, SettingsRow } from '../lib/settings-layout';
import { DEFAULT_SCANNER_SETTINGS, useScannerSettings } from '../lib/scanner-settings';
import { usePrintingSettings } from '../lib/printing-settings';
import { loadCachedSettings, loadCachedPricing } from '../lib/store-settings';
import { useTillName } from '../lib/till-name';
import { useDefaultCustomer } from '../lib/default-customer';
import { useCashierCustomer } from '../lib/cashier-customer';
import { authHeaders, createPosConnector } from '../lib/pos-connector';
import { THEME_CHOICES, useThemeChoice } from '../lib/theme-choice';
import { SCALE_CHOICES, useScaleChoice, type ScaleChoice } from '../lib/scale-choice';
import { averageKeyMs, stripScanAffixes } from '../lib/use-wedge-scan';
import { playScanBeep } from '../lib/scan-beep';
import { currencyFormat, separatorLabel } from '../lib/currency-format';
import { cardPaymentMode, TILL_PAYMENT_METHODS } from '../lib/card-payments';

const buttonClass = 'min-h-11 items-center justify-center rounded-md px-4';
// Shown for any value this till does not hold.
const UNKNOWN = '—';
// v2's nav-and-section layout starts at this width; a phone lists the sections and opens each on its own page.
const SETTINGS_SPLIT_MIN_WIDTH = 768;
const ChevronRightIcon = createSvgIcon('ChevronRightIcon', () => <Path d="m9 18 6-6-6-6" />);
const ChevronLeftIcon = createSvgIcon('ChevronLeftIcon', () => <Path d="m15 18-6-6 6-6" />);
const CheckIcon = createSvgIcon('CheckIcon', () => <Path d="M20 6 9 17l-5-5" />);

function Field({ label, help, ...input }: { label: string; help?: string } & ComponentProps<typeof TextInput>) {
  return <View className="gap-1">
    <Text className="text-foreground">{label}</Text>
    {help ? <Text className="text-sm text-muted-foreground">{help}</Text> : null}
    <TextInput className="min-h-11 rounded-md border border-border px-3 py-2 text-foreground" {...input} />
  </View>;
}
export default function SettingsScreen() {
  const { session } = useSession();
  const { width } = useWindowDimensions();
  const [chosenSection, setChosenSection] = useState('store');
  // A phone's section page is /settings?section=<id>, its own router entry, so browser and hardware back return to the list.
  const { section } = useLocalSearchParams<{ section?: string }>();
  // v2's Settings has no title bar on a wide window; a phone keeps the header for the drawer's Menu.
  const openMenu = useFrameMenu();
  // Without a header the sign-in / refused strip lies over the top of the screen (as on the Sale screen).
  const topInset = useContext(StripHeightContext);
  if (!session) return <Redirect href="/login" />;
  const sections = [
    { id: 'store', label: 'General', element: <StoreSection session={session} /> },
    { id: 'tax', label: 'Tax', element: <TaxSection session={session} /> },
    { id: 'printing', label: 'Printing', element: <PrintingSection session={session} /> },
    { id: 'card-readers', label: 'Card readers', element: <CardReadersSection session={session} /> },
    { id: 'scanner', label: 'Barcode Scanning', element: <ScannerSection session={session} /> },
    { id: 'theme', label: 'Theme', element: <ThemeSection /> },
    { id: 'register', label: 'Register', element: <RegisterSection session={session} /> },
    { id: 'danger', label: 'Danger zone', element: <ClearLocalDataSection /> },
  ];
  const chosen = sections.find(({ id }) => id === chosenSection) ?? sections[0];
  if (width >= SETTINGS_SPLIT_MIN_WIDTH) return <>
    <Stack.Screen options={{ title: 'Settings', headerShown: !!openMenu, headerLeft: () => <FrameMenuButton /> }} />
    <SettingsLayout layout="split" role="main" aria-label="Settings" navSlot={
      <View testID="settings-nav" className="gap-1 px-2 pb-2" style={{ paddingTop: 8 + topInset }}>
        {sections.map(({ id, label }) => <Pressable key={id} testID={`settings-nav-${id}`} accessibilityRole="button"
          aria-selected={chosenSection === id}
          accessibilityState={{ selected: chosenSection === id }} onPress={() => setChosenSection(id)}
          className={`min-h-11 justify-center rounded-md border px-4 ${chosenSection === id ? 'border-border bg-card shadow-sm' : 'border-transparent'}`}>
          <Text className="text-foreground">{label}</Text>
        </Pressable>)}
      </View>
    } contentSlot={
      <ScrollView className="flex-1 bg-background" contentContainerClassName="px-6 pb-6" contentContainerStyle={{ paddingTop: 24 + topInset }}>
        {/* v2 draws the chosen section in one full-width card, titled with its nav label. */}
        <Card testID="settings-section-card" className="w-full">
          <View className="border-b border-border px-4 py-3">
            <Text testID="settings-section-title" accessibilityRole="header" className="text-lg font-semibold text-card-foreground">{chosen?.label}</Text>
          </View>
          <View className="gap-6 p-4">
            {/* Its groups are flat, as v2's are: no box of their own, each value beside its label. */}
            <SettingsFlatContext.Provider value={true}>{chosen?.element}</SettingsFlatContext.Provider>
          </View>
        </Card>
      </ScrollView>
    } />
  </>;
  const opened = sections.find(({ id }) => id === section);
  // v2's phone Settings: a plain list of the section names, each with a chevron, opening that section's page.
  if (!opened) return <ScrollView className="flex-1 bg-background" role="main" aria-label="Settings" testID="settings-list"
    contentContainerClassName="pb-6" contentContainerStyle={{ paddingTop: 8 + topInset }}>
    <Stack.Screen options={{ title: 'Settings', headerShown: !!openMenu, headerLeft: () => <FrameMenuButton />, headerRight: () => <View className="pr-4"><AreaAccountButton /></View> }} />
    {sections.map(({ id, label }) => <Pressable key={id} testID={`settings-list-${id}`} accessibilityRole="button" accessibilityLabel={label}
      onPress={() => router.push({ pathname: '/settings', params: { section: id } })} className="min-h-11 justify-center px-2">
      <SettingsRow label={label} action={<View testID="settings-list-chevron" className="text-muted-foreground"><ChevronRightIcon size={20} /></View>} />
    </Pressable>)}
  </ScrollView>;
  return <ScrollView className="flex-1 bg-background" role="main" aria-label="Settings" contentContainerClassName="px-6 pb-6"
    contentContainerStyle={{ paddingTop: 24 + topInset }}>
    <Stack.Screen options={{ title: opened.label, headerShown: true, headerLeft: () => <SettingsBackButton />, headerRight: () => <View className="pr-4"><AreaAccountButton /></View> }} />
    <View className="w-full max-w-md gap-6 self-center">
      {opened.element}
    </View>
  </ScrollView>;
}
// A section page opened directly by URL has nothing under it, so back replaces it with the list.
function SettingsBackButton() {
  return <Pressable testID="settings-back" accessibilityRole="button" accessibilityLabel="Back to Settings"
    onPress={() => (router.canGoBack() ? router.back() : router.replace('/settings'))}
    className="ml-1 min-h-11 flex-row items-center gap-1 rounded-md pr-2">
    <View className="text-foreground"><ChevronLeftIcon size={24} /></View>
    <Text className="text-foreground">Settings</Text>
  </Pressable>;
}
// v2's "Set in WooCommerce · Open ↗" beside each read-only store value: opens the Medusa Admin page that sets it.
function AdminLink({ session, label, page, testID }: { session: Session; label: string; page: MedusaAdminPage; testID: string }) {
  return <Pressable testID={testID} accessibilityRole="link" accessibilityLabel={`Open ${label} in Medusa Admin`}
    className="-my-3 min-h-11 flex-row items-center gap-1" onPress={() => openMedusaAdmin(medusaAdminUrl(session.baseUrl, page))}>
    <Text className="text-sm text-primary">Open</Text>
    <ExternalLinkIcon size={14} className="text-primary" />
  </Pressable>;
}
function StoreSection({ session }: { session: Session }) {
  const [held] = useState(() => ({ settings: loadCachedSettings(defaultStorage(), session.baseUrl), pricing: loadCachedPricing(defaultStorage(), session.baseUrl) }));
  const [format] = useState(() => currencyFormat(held.pricing?.currency));
  // In the wide card's value column a two-line value reads from the left, as v2's do; a phone's keeps it at the right edge.
  const flat = useContext(SettingsFlatContext);
  return <>
  <SettingsGroup title="Store" description="Read-only. Set in Medusa Admin." testID="settings-store">
    <SettingsRow label="Store name" action={<View className="flex-row items-center gap-3">
      <Text testID="settings-store-name" className="max-w-40 text-right text-sm text-foreground">{held.settings?.storeName || UNKNOWN}</Text>
      <AdminLink session={session} label="Store name" page="store" testID="settings-store-name-admin" />
    </View>} />
    {/* The till's currency follows its region. */}
    <SettingsRow label="Currency" divider action={<View className="flex-row items-center gap-3">
      <Text testID="settings-store-currency" className="max-w-40 text-right text-sm text-foreground">{held.pricing?.currency || UNKNOWN}</Text>
      <AdminLink session={session} label="Currency" page="regions" testID="settings-store-currency-admin" />
    </View>} />
    <SettingsRow label="Stock location" divider action={<View className="flex-row items-center gap-3">
      <View className={`max-w-40 ${flat ? 'items-start' : 'items-end'}`}>
        <Text testID="settings-store-location" className={`max-w-40 ${flat ? '' : 'text-right '}text-sm text-foreground`}>{held.settings?.location.name || UNKNOWN}</Text>
        {held.settings?.location.addressLine ? <Text testID="settings-store-location-address" className={`${flat ? '' : 'text-right '}text-xs text-muted-foreground`}>{held.settings.location.addressLine}</Text> : null}
      </View>
      <AdminLink session={session} label="Stock location" page="locations" testID="settings-store-location-admin" />
    </View>} />
    <SettingsRow label="Sales channel" divider action={<View className="flex-row items-center gap-3">
      <Text testID="settings-store-sales-channel" className="max-w-40 text-right text-sm text-foreground">{held.settings?.salesChannel?.name || UNKNOWN}</Text>
      <AdminLink session={session} label="Sales channel" page="salesChannels" testID="settings-store-sales-channel-admin" />
    </View>} />
  </SettingsGroup>
  {/* v2's General holds the default customer between Store and Currency & numbers. */}
  <DefaultCustomerSection session={session} />
  <SettingsGroup title="Currency & numbers" description="Read-only. The currency follows the till's region, set in Medusa Admin; separators follow this device's language." testID="settings-currency">
    <SettingsRow label="Symbol" action={
      <Text testID="settings-currency-symbol" className="max-w-40 text-right text-sm text-foreground">{format ? format.symbol : UNKNOWN}</Text>
    } />
    <SettingsRow label="Symbol position" divider action={
      <Text testID="settings-currency-position" className="max-w-40 text-right text-sm text-foreground">{format ? (format.symbolPosition === 'left' ? 'Left' : 'Right') : UNKNOWN}</Text>
    } />
    <SettingsRow label="Thousands separator" divider action={
      <Text testID="settings-currency-thousands" className="max-w-40 text-right text-sm text-foreground">{format ? separatorLabel(format.thousandsSeparator) : UNKNOWN}</Text>
    } />
    <SettingsRow label="Decimal separator" divider action={
      <Text testID="settings-currency-decimal" className="max-w-40 text-right text-sm text-foreground">{format ? separatorLabel(format.decimalSeparator) : UNKNOWN}</Text>
    } />
    <SettingsRow label="Number of decimals" divider action={
      <Text testID="settings-currency-decimals" className="max-w-40 text-right text-sm text-foreground">{format ? String(format.decimals) : UNKNOWN}</Text>
    } />
    <SettingsRow label="Example" divider action={
      <Text testID="settings-currency-example" className="max-w-40 text-right text-sm text-foreground">{format ? format.example : UNKNOWN}</Text>
    } />
  </SettingsGroup>
  <SettingsGroup title="Feedback" description="Report a problem or suggest a change. Opens the tester feedback form on GitHub." testID="settings-feedback">
    <SettingsRow label="Send feedback" action={
      <Pressable testID="settings-feedback-link" accessibilityRole="link" accessibilityLabel="Send feedback"
        className="min-h-11 flex-row items-center gap-1" onPress={() => { openFeedbackUrl(feedbackUrl({
          appVersion, platform: Platform.OS,
          userAgent: Platform.OS === 'web' ? navigator.userAgent : undefined,
          backendUrl: session.baseUrl,
        })); }}>
        <Text className="text-sm text-primary">Open</Text>
        <ExternalLinkIcon size={14} className="text-primary" />
      </Pressable>
    } />
  </SettingsGroup>
  </>;
}
function TaxSection({ session }: { session: Session }) {
  const [held] = useState(() => ({ settings: loadCachedSettings(defaultStorage(), session.baseUrl), pricing: loadCachedPricing(defaultStorage(), session.baseUrl) }));
  const taxRates = held.settings?.taxRates;
  return <SettingsGroup title="Tax" description="Read-only. Set per region in Medusa Admin." testID="settings-tax">
    <SettingsRow label="Region" action={<View className="flex-row items-center gap-3">
      <Text testID="settings-store-region" className="max-w-40 text-right text-sm text-foreground">{held.settings?.regions?.find((region) => region.id === held.pricing?.pricingContext?.region_id)?.name || UNKNOWN}</Text>
      <AdminLink session={session} label="Region" page="regions" testID="settings-store-region-admin" />
    </View>} />
    <SettingsRow label="Prices include tax" divider action={<View className="flex-row items-center gap-3">
      <Text testID="settings-store-prices-include-tax" className="max-w-40 text-right text-sm text-foreground">{held.pricing?.pricesIncludeTax === true ? 'Yes' : held.pricing?.pricesIncludeTax === false ? 'No' : UNKNOWN}</Text>
      <AdminLink session={session} label="Prices include tax" page="regions" testID="settings-store-prices-include-tax-admin" />
    </View>} />
    {taxRates?.length ? taxRates.map((taxRate, index) => <SettingsRow key={index} label={taxRate.name} divider action={<View className="flex-row items-center gap-3">
      <Text testID={`settings-tax-rate-${index}`} className="max-w-40 text-right text-sm text-foreground">{`${taxRate.rate !== undefined ? `${taxRate.rate}%` : UNKNOWN}${taxRate.isDefault ? ' · Default' : ''}`}</Text>
      <AdminLink session={session} label={taxRate.name} page="taxRegions" testID={`settings-tax-rate-${index}-admin`} />
    </View>} />) : <SettingsRow label="Tax rates" divider action={<View className="flex-row items-center gap-3">
      <Text testID="settings-tax-rates-none" className="max-w-40 text-right text-sm text-foreground">{taxRates ? 'None' : UNKNOWN}</Text>
      <AdminLink session={session} label="Tax rates" page="taxRegions" testID="settings-tax-rates-admin" />
    </View>} />}
  </SettingsGroup>;
}
function RegisterSection({ session }: { session: Session }) {
  const { tillName, save } = useTillName(defaultStorage(), session.baseUrl);
  const [nameInput, setNameInput] = useState(tillName ?? '');
  const [error, setError] = useState<string | null>(null);
  function onSave() {
    try { save(nameInput); setError(null); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not save.'); }
  }
  return <SettingsGroup title="Register" testID="settings-register">
    <View className="gap-4 p-4">
      <Field accessibilityLabel="Till name" label="Till name" value={nameInput} onChangeText={setNameInput}
        help={`Shown to another till that finds this register open or takes it over. Leave empty to use “${getDeviceName()}”.`} />
      {error ? <Text className="text-sm text-destructive">{error}</Text> : null}
      <View className="flex-row gap-3">
        <Pressable accessibilityRole="button" accessibilityLabel="Save till name" onPress={onSave} className={`${buttonClass} bg-primary`}>
          <Text className="font-semibold text-primary-foreground">Save</Text>
        </Pressable>
      </View>
    </View>
  </SettingsGroup>;
}
function DefaultCustomerSection({ session }: { session: Session }) {
  const { customer, save } = useDefaultCustomer(defaultStorage(), session.baseUrl);
  const [open, setOpen] = useState(false);
  const { reportUnauthorized } = useSession();
  const connector = useMemo(() => createPosConnector(), []);
  const context = useMemo<SyncContext>(() => ({ connectorId: connector.id, baseUrl: session.baseUrl,
    headers: authHeaders(session.token) }), [connector.id, session.baseUrl, session.token]);
  const onError = (error: unknown) => { if (error instanceof ConnectorUnauthorizedError && error.code === 'unauthorized') reportUnauthorized(); };
  const cashier = useCashierCustomer(defaultStorage(), session,
    connector.searchCustomers ? (q) => connector.searchCustomers!(context, q) : undefined, onError);
  const cashierStatus = { off: null, resolving: 'Looking for your customer in Medusa…',
    found: `New sales start on ${cashier.customer?.name}, the customer in Medusa with your email.`,
    none: `No customer in Medusa has your email, ${session.email}. New sales start on the default customer above.`,
    offline: `Couldn't check Medusa. New sales start on ${cashier.customer?.name}.` }[cashier.status];
  const name = customer?.name ?? 'Guest';
  const available = !!connector.searchCustomers;
  const wide = useWindowDimensions().width >= SETTINGS_SPLIT_MIN_WIDTH;
  // v2's one select-style field: the current default, opening a dialog to choose Guest or a customer.
  return <SettingsGroup title="Customer" testID="settings-default-customer">
    <SettingsRow label="Default customer" description="Pre-selected on every new cart." action={
      <Pressable testID="settings-default-customer-field" accessibilityRole="button" accessibilityLabel={`Default customer: ${name}`}
        disabled={!available} accessibilityState={{ disabled: !available }} onPress={() => setOpen(true)}
        className={`min-h-11 ${wide ? 'w-72' : 'w-44'} flex-row items-center justify-between gap-2 rounded-md border border-border bg-background px-3${available ? '' : ' opacity-50'}`}>
        <Text testID="settings-default-customer-current" numberOfLines={1} className="shrink text-sm text-foreground">{name}</Text>
        <View className="text-muted-foreground"><ChevronDownIcon size={18} /></View>
      </Pressable>
    } />
    {!available && <View className="px-4 pb-4">
      <Text className="text-muted-foreground">Customers aren't available for this store.</Text>
    </View>}
    {available && <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent testID="settings-default-customer-dialog"><DialogTitle>Default customer</DialogTitle>
        <ScrollView contentContainerClassName="gap-3">
          <Pressable testID="settings-default-customer-guest" accessibilityRole="button" aria-selected={!customer}
            accessibilityState={{ selected: !customer }} onPress={() => { save(null); setOpen(false); }}
            // Chosen Guest wears the TallyUI customer select's chosen look, with a check after the label.
            className={customer ? 'items-center rounded-lg border border-border px-4 py-3'
              : 'flex-row items-center justify-center gap-2 rounded-lg border border-primary bg-primary/5 px-4 py-3'}>
            <Text className="text-sm font-semibold text-foreground">Guest</Text>
            {!customer && <View testID="settings-default-customer-guest-check" className="text-primary" aria-hidden
              importantForAccessibility="no-hide-descendants"><CheckIcon size={18} /></View>}
          </Pressable>
          <CustomerPicker selected={customer}
            // Settings has no sync state; the picker reports a failed search itself.
            online={true} search={(q) => connector.searchCustomers!(context, q)}
            onSelect={(c) => { save(c ? { id: c.id, name: c.name, ...(c.email !== undefined ? { email: c.email } : {}) } : null); setOpen(false); }}
            onError={(error) => { if (error instanceof ConnectorUnauthorizedError && error.code === 'unauthorized') reportUnauthorized(); }} />
        </ScrollView>
      </DialogContent>
    </Dialog>}
    {connector.searchCustomers && <SettingsRow label="Default customer is cashier" divider action={
      // TallyUI's Switch track sets no flex direction and react-native-web defaults to column, so
      // items-center would center the thumb and the "on" translate would push it past the track.
      <Switch accessibilityLabel="Default customer is cashier" testID="settings-default-customer-is-cashier" className="flex-row"
        checked={cashier.on} onCheckedChange={cashier.setOn} />
    } />}
    {connector.searchCustomers && cashierStatus ? <View className="px-4 pb-4">
      <Text testID="settings-default-customer-cashier-status" className="text-sm text-muted-foreground">{cashierStatus}</Text>
    </View> : null}
  </SettingsGroup>;
}
// Mirrors v2's "Auto — Print Dialog"; receipts print only through window.print() today.
const printMethodLabel = () => Platform.OS === 'web' ? 'Print dialog (browser)' : 'Not available on this device';
function PrintingSection({ session }: { session: Session }) {
  const { settings, save } = usePrintingSettings(defaultStorage(), session.baseUrl);
  return <>
  <SettingsGroup title="Printing" testID="settings-printing"
    description="Receipts print through this device's print dialog. Saved on this till only.">
    <SettingsRow label="Automatically print receipt after checkout" action={
      <Switch accessibilityLabel="Automatically print receipt after checkout" testID="settings-printing-auto-print" className="flex-row"
        checked={settings.autoPrintReceipt} onCheckedChange={(checked) => save({ ...settings, autoPrintReceipt: checked })} />
    } />
    <View className="px-4 pb-4">
      <Text className="text-sm text-muted-foreground">The print window opens after each sale.</Text>
    </View>
    <SettingsRow label="Print method" divider action={
      <Text testID="settings-printing-method" className="max-w-40 text-right text-sm text-foreground">{printMethodLabel()}</Text>
    } />
  </SettingsGroup>
  <PrintersGroup session={session} />
  <ReceiptTemplatesGroup session={session} />
  </>;
}
function CardReadersSection({ session }: { session: Session }) {
  const mode = cardPaymentMode(TILL_PAYMENT_METHODS);
  return <><SettingsGroup title="Card readers" testID="settings-card-readers" description="How this till takes card payments. Read-only.">
    {mode ? <>
      <SettingsRow label="Card method" action={
        <Text testID="settings-card-readers-method" className="max-w-40 text-right text-sm text-foreground">{mode.method}</Text>
      } />
      <SettingsRow label="Taken on" divider action={
        <Text testID="settings-card-readers-capture" className="max-w-40 text-right text-sm text-foreground">{mode.capture}</Text>
      } />
      <SettingsRow label="Readers" divider action={
        <Text testID="settings-card-readers-readers" className="max-w-40 text-right text-sm text-foreground">{mode.readers}</Text>
      } />
      {mode.manual ? <View className="px-4 pb-4">
        <Text testID="settings-card-readers-how" className="text-sm text-muted-foreground">{`At checkout, pick ${mode.method}, take the payment on the terminal, then type its receipt number in Terminal reference. The terminal works on its own: there is nothing to pair with this till.`}</Text>
      </View> : null}
    </> : <View className="px-4 pb-4">
      <Text testID="settings-card-readers-none" className="text-sm text-muted-foreground">This till takes no card payments.</Text>
    </View>}
  </SettingsGroup>
  <PaymentProvidersGroup session={session} />
  </>;
}
function ScannerSection({ session }: { session: Session }) {
  const { settings, save, reset } = useScannerSettings(defaultStorage(), session.baseUrl);
  const [avgKeyMsInput, setAvgKeyMsInput] = useState(String(settings.avgKeyMs));
  const [minCharsInput, setMinCharsInput] = useState(String(settings.minChars));
  const [prefixInput, setPrefixInput] = useState(settings.prefix);
  const [suffixInput, setSuffixInput] = useState(settings.suffix);
  const [error, setError] = useState<string | null>(null);
  const [cameraSupported] = useState(cameraScanSupported);
  function onSave() {
    try { save({ ...settings, avgKeyMs: Number(avgKeyMsInput), minChars: Number(minCharsInput), prefix: prefixInput, suffix: suffixInput }); setError(null); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not save.'); }
  }
  function onReset() {
    reset(); setAvgKeyMsInput(String(DEFAULT_SCANNER_SETTINGS.avgKeyMs));
    setMinCharsInput(String(DEFAULT_SCANNER_SETTINGS.minChars)); setError(null);
    setPrefixInput(DEFAULT_SCANNER_SETTINGS.prefix); setSuffixInput(DEFAULT_SCANNER_SETTINGS.suffix);
  }
  const [testValue, setTestValue] = useState(''), [lastScan, setLastScan] = useState<{ code: string; avgMs: number } | null>(null);
  // Mirrors the wedge listener's own buffer (use-wedge-scan.ts), but on this focused field: it wants an
  // editable target, the opposite of the cart-view listener.
  const timing = useRef({ buffer: '', firstAt: 0, lastAt: 0 });
  function onTestKeyPress(event: NativeSyntheticEvent<TextInputKeyPressEventData>) {
    const key = event.nativeEvent.key, now = Date.now();
    if (key === 'Enter') {
      const { buffer, firstAt, lastAt } = timing.current;
      if (buffer) {
        const code = stripScanAffixes(buffer, settings), avgMs = averageKeyMs(firstAt, lastAt, buffer.length);
        setLastScan({ code, avgMs });
        const counts = code.length >= settings.minChars && avgMs <= settings.avgKeyMs;
        if (counts && settings.playSound) playScanBeep();
      }
      timing.current = { buffer: '', firstAt: 0, lastAt: 0 }; setTestValue('');
      return;
    }
    if (key.length !== 1) return;
    if (!timing.current.buffer) timing.current.firstAt = now;
    timing.current.buffer += key; timing.current.lastAt = now;
  }
  const counts = lastScan !== null && lastScan.code.length >= settings.minChars && lastScan.avgMs <= settings.avgKeyMs;
  return <SettingsGroup title="Barcode Scanning" testID="settings-scanner">
    <View className="gap-4 p-4">
      <Field accessibilityLabel="Average time per key (ms)" label="Average time per key (ms)" help="A scan is faster than typing. Raise this for slow Bluetooth scanners."
        value={avgKeyMsInput} onChangeText={setAvgKeyMsInput} keyboardType="number-pad" />
      <Field accessibilityLabel="Minimum characters" label="Minimum characters" help="Codes shorter than this are treated as typing, not a scan"
        value={minCharsInput} onChangeText={setMinCharsInput} keyboardType="number-pad" />
      <Field accessibilityLabel="Scanner prefix" label="Scanner prefix" help="One character your scanner sends before each code. Removed before lookup."
        value={prefixInput} onChangeText={setPrefixInput} maxLength={1} autoCapitalize="none" autoCorrect={false} />
      <Field accessibilityLabel="Scanner suffix" label="Scanner suffix" help="One character your scanner sends after each code. Removed before lookup."
        value={suffixInput} onChangeText={setSuffixInput} maxLength={1} autoCapitalize="none" autoCorrect={false} />
      {error ? <Text className="text-sm text-destructive">{error}</Text> : null}
      <View className="flex-row gap-3">
        <Pressable accessibilityRole="button" onPress={onSave} className={`${buttonClass} bg-primary`}>
          <Text className="font-semibold text-primary-foreground">Save</Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={onReset} className={`${buttonClass} border border-border`}>
          <Text className="text-foreground">Reset to defaults</Text>
        </Pressable>
      </View>
      <SettingsRow label="Play a sound on scan" className="border-t border-border px-0" action={
        <Switch accessibilityLabel="Play a sound on scan" testID="settings-scanner-sound" className="flex-row" checked={settings.playSound} onCheckedChange={(checked) => {
          try { save({ ...settings, playSound: checked }); setError(null); }
          catch (err) { setError(err instanceof Error ? err.message : 'Could not save.'); }
        }} />
      } />
      {cameraSupported ? <SettingsRow label="Use camera" className="border-t border-border px-0"
        description="Shows a camera button beside the Sale's search box. The browser asks for the camera the first time." action={
        <Switch accessibilityLabel="Use camera to scan barcodes" testID="settings-scanner-camera" className="flex-row" checked={settings.camera} onCheckedChange={(checked) => {
          try { save({ ...settings, camera: checked }); setError(null); }
          catch (err) { setError(err instanceof Error ? err.message : 'Could not save.'); }
        }} />
      } /> : null}
      <DirectScannerConnection />
      <View className="gap-1 border-t border-border pt-4">
        <Field accessibilityLabel="Test scan here" label="Test scan here" help="Scan a barcode into this field to check it counts as a scan" value={testValue} onChangeText={setTestValue} onKeyPress={onTestKeyPress} />
        {lastScan ? <Text className="text-sm text-muted-foreground">{`Last scan: ${lastScan.code} · ${lastScan.code.length} characters · average ${Math.round(lastScan.avgMs)} ms per key`}</Text> : null}
        {lastScan ? <Text className={`text-sm ${counts ? 'text-foreground' : 'text-destructive'}`}>{counts ? 'Counts as a scan' : 'Too slow / too short'}</Text> : null}
      </View>
    </View>
  </SettingsGroup>;
}

const SCALE_LABELS: Record<ScaleChoice, string> = { auto: 'Auto', compact: 'Compact', regular: 'Regular', spacious: 'Spacious' };

function ThemeSection() {
  const { choice, save } = useThemeChoice(defaultStorage());
  const { choice: scale, save: saveScale } = useScaleChoice(defaultStorage());
  return <SettingsGroup title="Theme" description="Light, dark, follow this device's setting, or a colour theme. Saved on this till only." testID="settings-theme">
    <View className="gap-3 p-4">
      <Text className="text-sm text-muted-foreground" testID="settings-theme-current">Current Theme: {THEME_LABELS[choice]}</Text>
      <ThemeTiles choice={choice} choices={THEME_CHOICES} onChoose={(value) => { if (value !== choice) save(value); }} />
    </View>
    <View className="border-t border-border p-4 gap-2" testID="settings-scale">
      <Text className="text-foreground font-medium">Scale</Text>
      <Text className="text-sm text-muted-foreground">Auto follows the window size. Saved on this till only.</Text>
      <Text className="text-sm text-muted-foreground" testID="settings-scale-current">Current scale: {SCALE_LABELS[scale]}</Text>
      <ToggleGroup type="single" variant="outline" aria-label="Scale" value={scale} className="flex-wrap justify-start"
        onValueChange={(value) => { if (value && value !== scale) saveScale(value as ScaleChoice); }}>
        {SCALE_CHOICES.map((id) => <ToggleGroupItem key={id} value={id} testID={`scale-choice-${id}`}
          className={scale === id ? 'bg-accent' : ''}>
          <TallyText>{SCALE_LABELS[id]}</TallyText>
        </ToggleGroupItem>)}
      </ToggleGroup>
    </View>
    <FontPicker />
  </SettingsGroup>;
}
