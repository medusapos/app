import { useRef, useState, type ComponentProps } from 'react';
import { Pressable, ScrollView, Text, TextInput, View, type NativeSyntheticEvent, type TextInputKeyPressEventData } from 'react-native';
import { Redirect, Stack } from 'expo-router';
import { SettingsGroup, SettingsRow, ToggleGroup, ToggleGroupItem } from '@tallyui/components';
import { ClearLocalDataSection } from '../components/clear-local-data';
import { ProductsBack } from '../components/products-back';
import { defaultStorage, type Session } from '../lib/session';
import { useSession } from '../lib/session-context';
import { getDeviceName } from '../lib/register-context';
import { DEFAULT_SCANNER_SETTINGS, useScannerSettings } from '../lib/scanner-settings';
import { loadCachedSettings, loadCachedPricing } from '../lib/store-settings';
import { useTillName } from '../lib/till-name';
import { THEME_CHOICES, isThemeChoice, useThemeChoice, type ThemeChoice } from '../lib/theme-choice';
import { averageKeyMs } from '../lib/use-wedge-scan';

const buttonClass = 'min-h-11 items-center justify-center rounded-md px-4';
// Shown for any value this till does not hold.
const UNKNOWN = '—';

function Field({ label, help, ...input }: { label: string; help?: string } & ComponentProps<typeof TextInput>) {
  return <View className="gap-1">
    <Text className="text-foreground">{label}</Text>
    {help ? <Text className="text-sm text-muted-foreground">{help}</Text> : null}
    <TextInput className="min-h-11 rounded-md border border-border px-3 py-2 text-foreground" {...input} />
  </View>;
}
export default function SettingsScreen() {
  const { session } = useSession();
  if (!session) return <Redirect href="/login" />;
  return <ScrollView className="flex-1 bg-background" contentContainerClassName="px-6 py-6">
    <Stack.Screen options={{ title: 'Settings', headerLeft: () => <ProductsBack /> }} />
    <View className="w-full max-w-md gap-6 self-center">
      <StoreSection session={session} />
      <RegisterSection session={session} />
      <ScannerSection session={session} />
      <ThemeSection />
      <ClearLocalDataSection />
    </View>
  </ScrollView>;
}
// Printer settings land here later (ADR 0016), with TallyUI printing.
function StoreSection({ session }: { session: Session }) {
  const [held] = useState(() => ({ settings: loadCachedSettings(defaultStorage(), session.baseUrl), pricing: loadCachedPricing(defaultStorage(), session.baseUrl) }));
  return <SettingsGroup title="Store" description="Read-only. Set in Medusa Admin." testID="settings-store">
    <SettingsRow label="Store name" action={
      <Text testID="settings-store-name" className="max-w-40 text-right text-sm text-foreground">{held.settings?.storeName || UNKNOWN}</Text>
    } />
    <SettingsRow label="Currency" className="border-t border-border" action={
      <Text testID="settings-store-currency" className="max-w-40 text-right text-sm text-foreground">{held.pricing?.currency || UNKNOWN}</Text>
    } />
    <SettingsRow label="Region" className="border-t border-border" action={
      <Text testID="settings-store-region" className="max-w-40 text-right text-sm text-foreground">{held.settings?.regions?.find((region) => region.id === held.pricing?.pricingContext?.region_id)?.name || UNKNOWN}</Text>
    } />
    <SettingsRow label="Prices include tax" className="border-t border-border" action={
      <Text testID="settings-store-prices-include-tax" className="max-w-40 text-right text-sm text-foreground">{held.pricing?.pricesIncludeTax === true ? 'Yes' : held.pricing?.pricesIncludeTax === false ? 'No' : UNKNOWN}</Text>
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
function ScannerSection({ session }: { session: Session }) {
  const { settings, save, reset } = useScannerSettings(defaultStorage(), session.baseUrl);
  const [avgKeyMsInput, setAvgKeyMsInput] = useState(String(settings.avgKeyMs));
  const [minCharsInput, setMinCharsInput] = useState(String(settings.minChars));
  const [error, setError] = useState<string | null>(null);
  function onSave() {
    try { save({ avgKeyMs: Number(avgKeyMsInput), minChars: Number(minCharsInput) }); setError(null); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not save.'); }
  }
  function onReset() {
    reset(); setAvgKeyMsInput(String(DEFAULT_SCANNER_SETTINGS.avgKeyMs));
    setMinCharsInput(String(DEFAULT_SCANNER_SETTINGS.minChars)); setError(null);
  }
  const [testValue, setTestValue] = useState(''), [lastScan, setLastScan] = useState<{ code: string; avgMs: number } | null>(null);
  // Mirrors the wedge listener's own buffer (use-wedge-scan.ts), but on this focused field: it wants an
  // editable target, the opposite of the cart-view listener.
  const timing = useRef({ buffer: '', firstAt: 0, lastAt: 0 });
  function onTestKeyPress(event: NativeSyntheticEvent<TextInputKeyPressEventData>) {
    const key = event.nativeEvent.key, now = Date.now();
    if (key === 'Enter') {
      const { buffer, firstAt, lastAt } = timing.current;
      if (buffer) setLastScan({ code: buffer, avgMs: averageKeyMs(firstAt, lastAt, buffer.length) });
      timing.current = { buffer: '', firstAt: 0, lastAt: 0 }; setTestValue('');
      return;
    }
    if (key.length !== 1) return;
    if (!timing.current.buffer) timing.current.firstAt = now;
    timing.current.buffer += key; timing.current.lastAt = now;
  }
  const counts = lastScan !== null && lastScan.code.length >= settings.minChars && lastScan.avgMs <= settings.avgKeyMs;
  return <SettingsGroup title="Scanner" testID="settings-scanner">
    <View className="gap-4 p-4">
      <Field accessibilityLabel="Average time per key (ms)" label="Average time per key (ms)" help="A scan is faster than typing. Raise this for slow Bluetooth scanners."
        value={avgKeyMsInput} onChangeText={setAvgKeyMsInput} keyboardType="number-pad" />
      <Field accessibilityLabel="Minimum characters" label="Minimum characters" help="Codes shorter than this are treated as typing, not a scan"
        value={minCharsInput} onChangeText={setMinCharsInput} keyboardType="number-pad" />
      {error ? <Text className="text-sm text-destructive">{error}</Text> : null}
      <View className="flex-row gap-3">
        <Pressable accessibilityRole="button" onPress={onSave} className={`${buttonClass} bg-primary`}>
          <Text className="font-semibold text-primary-foreground">Save</Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={onReset} className={`${buttonClass} border border-border`}>
          <Text className="text-foreground">Reset to defaults</Text>
        </Pressable>
      </View>
      <View className="gap-1 border-t border-border pt-4">
        <Field accessibilityLabel="Test scan here" label="Test scan here" help="Scan a barcode into this field to check it counts as a scan" value={testValue} onChangeText={setTestValue} onKeyPress={onTestKeyPress} />
        {lastScan ? <Text className="text-sm text-muted-foreground">{`Last scan: ${lastScan.code} · ${lastScan.code.length} characters · average ${Math.round(lastScan.avgMs)} ms per key`}</Text> : null}
        {lastScan ? <Text className={`text-sm ${counts ? 'text-foreground' : 'text-destructive'}`}>{counts ? 'Counts as a scan' : 'Too slow / too short'}</Text> : null}
      </View>
    </View>
  </SettingsGroup>;
}

const THEME_LABELS: Record<ThemeChoice, string> = { system: 'System', light: 'Light', dark: 'Dark' };

function ThemeSection() {
  const { choice, save } = useThemeChoice(defaultStorage());
  return <SettingsGroup title="Theme" description="Light, dark, or follow this device's setting. Saved on this till only." testID="settings-theme">
    <View className="p-4">
      <ToggleGroup type="single" value={choice} size="lg" accessibilityLabel="Theme" testID="settings-theme-choice"
        onValueChange={(value) => { if (isThemeChoice(value) && value !== choice) save(value); }}
        className="self-start flex-row gap-0 overflow-hidden rounded-md border border-border">
        {THEME_CHOICES.map((value, index) => <ToggleGroupItem key={value} value={value}
          testID={`settings-theme-${value}`} accessibilityLabel={THEME_LABELS[value]}
          className={`rounded-none ${value === choice ? 'bg-primary web:hover:bg-primary' : 'bg-card'}${index > 0 ? ' border-l border-border' : ''}`}>
          <Text className={`text-sm font-medium ${value === choice ? 'text-primary-foreground' : 'text-foreground'}`}>{THEME_LABELS[value]}</Text>
        </ToggleGroupItem>)}
      </ToggleGroup>
    </View>
  </SettingsGroup>;
}
