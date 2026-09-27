import { useRef, useState, type ComponentProps } from 'react';
import { Pressable, ScrollView, Text, TextInput, View, type NativeSyntheticEvent, type TextInputKeyPressEventData } from 'react-native';
import { Redirect, Stack } from 'expo-router';
import { defaultStorage, type Session } from '../lib/session';
import { useSession } from '../lib/session-context';
import { DEFAULT_SCANNER_SETTINGS, useScannerSettings } from '../lib/scanner-settings';
import { averageKeyMs } from '../lib/use-wedge-scan';

const buttonClass = 'min-h-11 items-center justify-center rounded-md px-4';

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
  return <ScannerSection session={session} />;
}
// Register and printer settings land here later (ADR 0016); Scanner is the first section.
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
  return <ScrollView className="flex-1 bg-background" contentContainerClassName="px-6 py-6">
    <Stack.Screen options={{ title: 'Settings' }} />
    <View className="w-full max-w-md gap-4 self-center">
      <Text className="text-lg font-semibold text-foreground">Scanner</Text>
      <Field accessibilityLabel="Average time per key (ms)" label="Average time per key (ms)" help="A scan is faster than typing. Raise this for slow Bluetooth scanners."
        value={avgKeyMsInput} onChangeText={setAvgKeyMsInput} keyboardType="number-pad" />
      <Field accessibilityLabel="Minimum characters" label="Minimum characters"
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
        <Field accessibilityLabel="Test scan here" label="Test scan here" value={testValue} onChangeText={setTestValue} onKeyPress={onTestKeyPress} />
        {lastScan ? <Text className="text-sm text-muted-foreground">{`Last scan: ${lastScan.code} · ${lastScan.code.length} characters · average ${Math.round(lastScan.avgMs)} ms per key`}</Text> : null}
        {lastScan ? <Text className={`text-sm ${counts ? 'text-foreground' : 'text-destructive'}`}>{counts ? 'Counts as a scan' : 'Too slow / too short'}</Text> : null}
      </View>
    </View>
  </ScrollView>;
}
