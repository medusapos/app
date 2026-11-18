import { Fragment, useMemo, useRef, useState, type ComponentProps } from 'react';
import { Platform, Pressable, ScrollView, TextInput, View, useWindowDimensions, type NativeSyntheticEvent, type TextInputKeyPressEventData } from 'react-native';
import { AppText as Text } from '../components/app-text';
import { Redirect, Stack } from 'expo-router';
import { Card, CustomerPicker, SettingsGroup, SettingsLayout, SettingsRow, Switch, Text as TallyText, ToggleGroup, ToggleGroupItem } from '@tallyui/components';
import { ConnectorUnauthorizedError, type SyncContext } from '@tallyui/core';
import { ClearLocalDataSection } from '../components/clear-local-data';
import { DirectScannerConnection } from '../components/device-scanner';
import { THEME_LABELS, ThemeTiles } from '../components/theme-tiles';
import { FontPicker } from '../components/font-choice';
import { FrameMenuButton } from '../components/app-frame';
import { defaultStorage, type Session } from '../lib/session';
import { useSession } from '../lib/session-context';
import { getDeviceName } from '../lib/register-context';
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
// v2's nav-and-section layout starts at this width; a phone keeps one page.
const SETTINGS_SPLIT_MIN_WIDTH = 768;

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
  if (!session) return <Redirect href="/login" />;
  const sections = [
    { id: 'store', label: 'General', element: <StoreSection session={session} /> },
    { id: 'tax', label: 'Tax', element: <TaxSection session={session} /> },
    { id: 'printing', label: 'Printing', element: <PrintingSection session={session} /> },
    { id: 'card-readers', label: 'Card readers', element: <CardReadersSection /> },
    { id: 'scanner', label: 'Barcode Scanning', element: <ScannerSection session={session} /> },
    { id: 'theme', label: 'Theme', element: <ThemeSection /> },
    { id: 'register', label: 'Register', element: <RegisterSection session={session} /> },
    { id: 'customer', label: 'Customer', element: <DefaultCustomerSection session={session} /> },
    { id: 'danger', label: 'Danger zone', element: <ClearLocalDataSection /> },
  ];
  const chosen = sections.find(({ id }) => id === chosenSection);
  if (width >= SETTINGS_SPLIT_MIN_WIDTH) return <>
    <Stack.Screen options={{ title: 'Settings', headerLeft: () => <FrameMenuButton /> }} />
    <SettingsLayout layout="split" navSlot={
      <View testID="settings-nav" className="gap-1 p-2">
        {sections.map(({ id, label }) => <Pressable key={id} testID={`settings-nav-${id}`} accessibilityRole="button"
          aria-selected={chosenSection === id}
          accessibilityState={{ selected: chosenSection === id }} onPress={() => setChosenSection(id)}
          className={`min-h-11 justify-center rounded-md border px-4 ${chosenSection === id ? 'border-border bg-card shadow-sm' : 'border-transparent'}`}>
          <Text className="text-foreground">{label}</Text>
        </Pressable>)}
      </View>
    } contentSlot={
      <ScrollView className="flex-1 bg-background" contentContainerClassName="px-6 py-6">
        {/* v2 draws the chosen section in one full-width card, titled with its nav label. */}
        <Card testID="settings-section-card" className="w-full">
          <View className="border-b border-border px-4 py-3">
            <Text testID="settings-section-title" accessibilityRole="header" className="text-lg font-semibold text-card-foreground">{chosen?.label}</Text>
          </View>
          <View className="gap-6 p-4">
            {chosen?.element}
          </View>
        </Card>
      </ScrollView>
    } />
  </>;
  return <ScrollView className="flex-1 bg-background" contentContainerClassName="px-6 py-6">
    <Stack.Screen options={{ title: 'Settings', headerLeft: () => <FrameMenuButton /> }} />
    <View className="w-full max-w-md gap-6 self-center">
      {sections.map(({ id, element }) => <Fragment key={id}>{element}</Fragment>)}
    </View>
  </ScrollView>;
}
function StoreSection({ session }: { session: Session }) {
  const [held] = useState(() => ({ settings: loadCachedSettings(defaultStorage(), session.baseUrl), pricing: loadCachedPricing(defaultStorage(), session.baseUrl) }));
  const [format] = useState(() => currencyFormat(held.pricing?.currency));
  return <>
  <SettingsGroup title="Store" description="Read-only. Set in Medusa Admin." testID="settings-store">
    <SettingsRow label="Store name" action={
      <Text testID="settings-store-name" className="max-w-40 text-right text-sm text-foreground">{held.settings?.storeName || UNKNOWN}</Text>
    } />
    <SettingsRow label="Currency" className="border-t border-border" action={
      <Text testID="settings-store-currency" className="max-w-40 text-right text-sm text-foreground">{held.pricing?.currency || UNKNOWN}</Text>
    } />
    <SettingsRow label="Stock location" className="border-t border-border" action={
      <View className="max-w-40 items-end">
        <Text testID="settings-store-location" className="max-w-40 text-right text-sm text-foreground">{held.settings?.location.name || UNKNOWN}</Text>
        {held.settings?.location.addressLine ? <Text testID="settings-store-location-address" className="text-right text-xs text-muted-foreground">{held.settings.location.addressLine}</Text> : null}
      </View>
    } />
    <SettingsRow label="Sales channel" className="border-t border-border" action={
      <Text testID="settings-store-sales-channel" className="max-w-40 text-right text-sm text-foreground">{held.settings?.salesChannel?.name || UNKNOWN}</Text>
    } />
  </SettingsGroup>
  <SettingsGroup title="Currency & numbers" description="Read-only. The currency follows the till's region, set in Medusa Admin; separators follow this device's language." testID="settings-currency">
    <SettingsRow label="Symbol" action={
      <Text testID="settings-currency-symbol" className="max-w-40 text-right text-sm text-foreground">{format ? format.symbol : UNKNOWN}</Text>
    } />
    <SettingsRow label="Symbol position" className="border-t border-border" action={
      <Text testID="settings-currency-position" className="max-w-40 text-right text-sm text-foreground">{format ? (format.symbolPosition === 'left' ? 'Left' : 'Right') : UNKNOWN}</Text>
    } />
    <SettingsRow label="Thousands separator" className="border-t border-border" action={
      <Text testID="settings-currency-thousands" className="max-w-40 text-right text-sm text-foreground">{format ? separatorLabel(format.thousandsSeparator) : UNKNOWN}</Text>
    } />
    <SettingsRow label="Decimal separator" className="border-t border-border" action={
      <Text testID="settings-currency-decimal" className="max-w-40 text-right text-sm text-foreground">{format ? separatorLabel(format.decimalSeparator) : UNKNOWN}</Text>
    } />
    <SettingsRow label="Number of decimals" className="border-t border-border" action={
      <Text testID="settings-currency-decimals" className="max-w-40 text-right text-sm text-foreground">{format ? String(format.decimals) : UNKNOWN}</Text>
    } />
    <SettingsRow label="Example" className="border-t border-border" action={
      <Text testID="settings-currency-example" className="max-w-40 text-right text-sm text-foreground">{format ? format.example : UNKNOWN}</Text>
    } />
  </SettingsGroup>
  </>;
}
function TaxSection({ session }: { session: Session }) {
  const [held] = useState(() => ({ settings: loadCachedSettings(defaultStorage(), session.baseUrl), pricing: loadCachedPricing(defaultStorage(), session.baseUrl) }));
  const taxRates = held.settings?.taxRates;
  return <SettingsGroup title="Tax" description="Read-only. Set per region in Medusa Admin." testID="settings-tax">
    <SettingsRow label="Region" action={
      <Text testID="settings-store-region" className="max-w-40 text-right text-sm text-foreground">{held.settings?.regions?.find((region) => region.id === held.pricing?.pricingContext?.region_id)?.name || UNKNOWN}</Text>
    } />
    <SettingsRow label="Prices include tax" className="border-t border-border" action={
      <Text testID="settings-store-prices-include-tax" className="max-w-40 text-right text-sm text-foreground">{held.pricing?.pricesIncludeTax === true ? 'Yes' : held.pricing?.pricesIncludeTax === false ? 'No' : UNKNOWN}</Text>
    } />
    {taxRates?.length ? taxRates.map((taxRate, index) => <SettingsRow key={index} label={taxRate.name} className="border-t border-border" action={
      <Text testID={`settings-tax-rate-${index}`} className="max-w-40 text-right text-sm text-foreground">{`${taxRate.rate !== undefined ? `${taxRate.rate}%` : UNKNOWN}${taxRate.isDefault ? ' · Default' : ''}`}</Text>
    } />) : <SettingsRow label="Tax rates" className="border-t border-border" action={
      <Text testID="settings-tax-rates-none" className="max-w-40 text-right text-sm text-foreground">{taxRates ? 'None' : UNKNOWN}</Text>
    } />}
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
  return <SettingsGroup title="Default customer" testID="settings-default-customer"
    description="Every new sale on this till starts with this customer. A cashier can still change it on a sale.">
    <View className="gap-4 p-4">
      <Text testID="settings-default-customer-current" className="text-foreground">{customer?.name ?? 'Guest'}</Text>
      {connector.searchCustomers ? <CustomerPicker selected={customer}
        // Settings has no sync state; the picker reports a failed search itself.
        online={true} search={(q) => connector.searchCustomers!(context, q)}
        onSelect={(c) => save(c ? { id: c.id, name: c.name, ...(c.email !== undefined ? { email: c.email } : {}) } : null)}
        onError={(error) => { if (error instanceof ConnectorUnauthorizedError && error.code === 'unauthorized') reportUnauthorized(); }} />
        : <Text className="text-muted-foreground">Customers aren't available for this store.</Text>}
      {customer && <Pressable testID="settings-default-customer-clear" accessibilityRole="button"
        onPress={() => save(null)} className={`${buttonClass} border border-border`}>
        <Text className="text-foreground">Use Guest</Text>
      </Pressable>}
    </View>
    {connector.searchCustomers && <SettingsRow label="Default customer is cashier" className="border-t border-border" action={
      <Switch accessibilityLabel="Default customer is cashier" testID="settings-default-customer-is-cashier"
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
  return <SettingsGroup title="Printing" testID="settings-printing"
    description="Receipts print through this device's print dialog. Saved on this till only.">
    <SettingsRow label="Automatically print receipt after checkout" action={
      <Switch accessibilityLabel="Automatically print receipt after checkout" testID="settings-printing-auto-print"
        checked={settings.autoPrintReceipt} onCheckedChange={(checked) => save({ ...settings, autoPrintReceipt: checked })} />
    } />
    <View className="px-4 pb-4">
      <Text className="text-sm text-muted-foreground">The print window opens after each sale.</Text>
    </View>
    <SettingsRow label="Print method" className="border-t border-border" action={
      <Text testID="settings-printing-method" className="max-w-40 text-right text-sm text-foreground">{printMethodLabel()}</Text>
    } />
  </SettingsGroup>;
}
function CardReadersSection() {
  const mode = cardPaymentMode(TILL_PAYMENT_METHODS);
  return <SettingsGroup title="Card readers" testID="settings-card-readers" description="How this till takes card payments. Read-only.">
    {mode ? <>
      <SettingsRow label="Card method" action={
        <Text testID="settings-card-readers-method" className="max-w-40 text-right text-sm text-foreground">{mode.method}</Text>
      } />
      <SettingsRow label="Taken on" className="border-t border-border" action={
        <Text testID="settings-card-readers-capture" className="max-w-40 text-right text-sm text-foreground">{mode.capture}</Text>
      } />
      <SettingsRow label="Readers" className="border-t border-border" action={
        <Text testID="settings-card-readers-readers" className="max-w-40 text-right text-sm text-foreground">{mode.readers}</Text>
      } />
      {mode.manual ? <View className="px-4 pb-4">
        <Text testID="settings-card-readers-how" className="text-sm text-muted-foreground">{`At checkout, pick ${mode.method}, take the payment on the terminal, then type its receipt number in Terminal reference. The terminal works on its own: there is nothing to pair with this till.`}</Text>
      </View> : null}
    </> : <View className="px-4 pb-4">
      <Text testID="settings-card-readers-none" className="text-sm text-muted-foreground">This till takes no card payments.</Text>
    </View>}
  </SettingsGroup>;
}
function ScannerSection({ session }: { session: Session }) {
  const { settings, save, reset } = useScannerSettings(defaultStorage(), session.baseUrl);
  const [avgKeyMsInput, setAvgKeyMsInput] = useState(String(settings.avgKeyMs));
  const [minCharsInput, setMinCharsInput] = useState(String(settings.minChars));
  const [prefixInput, setPrefixInput] = useState(settings.prefix);
  const [suffixInput, setSuffixInput] = useState(settings.suffix);
  const [error, setError] = useState<string | null>(null);
  function onSave() {
    try { save({ avgKeyMs: Number(avgKeyMsInput), minChars: Number(minCharsInput), prefix: prefixInput, suffix: suffixInput, playSound: settings.playSound }); setError(null); }
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
        <Switch accessibilityLabel="Play a sound on scan" testID="settings-scanner-sound" checked={settings.playSound} onCheckedChange={(checked) => {
          try { save({ ...settings, playSound: checked }); setError(null); }
          catch (err) { setError(err instanceof Error ? err.message : 'Could not save.'); }
        }} />
      } />
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
