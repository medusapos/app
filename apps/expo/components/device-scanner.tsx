import { useMemo, useState, type ReactNode } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { AppText as Text } from './app-text';
import { ScanHubProvider, useDeviceScanControls, type DeviceScannerErrorHandler, type HidLike, type SerialLike } from '@tallyui/pos';
import { forgetScannerProfile, scannerProfileStoreFor, useScannerProfiles } from '../lib/scanner-profiles';
import { useScannerSettings } from '../lib/scanner-settings';
import { defaultStorage } from '../lib/session';
import { useSession } from '../lib/session-context';
import { SettingsRow } from '../lib/settings-layout';

const buttonClass = 'min-h-11 items-center justify-center rounded-md px-4 border border-border';

// The cashier closing the browser's chooser is not a failure.
const onError: DeviceScannerErrorHandler = (error, { cancelled }) => {
  if (!cancelled) console.warn('Scanner connection failed:', error);
};

/** TallyUI's app-scoped scan hub and direct (WebHID, Web Serial) connections, on the till's scanner settings.
 * `hid` and `serial` default to the browser's (absent on native); they are props for tests. */
export function DeviceScannerProvider({ children, hid, serial }: { children: ReactNode; hid?: HidLike; serial?: SerialLike }) {
  const { session } = useSession();
  const { settings } = useScannerSettings(defaultStorage(), session?.baseUrl ?? '');
  const profiles = useMemo(() => scannerProfileStoreFor(defaultStorage()), []);
  return <ScanHubProvider profiles={profiles} settings={{ prefix: settings.prefix, suffix: settings.suffix, minChars: settings.minChars }}
    onError={onError} {...(hid ? { hid } : {})} {...(serial ? { serial } : {})}>{children}</ScanHubProvider>;
}

/** Settings > Scanner's "Direct connection" (v2's advanced connect): web only, where WebHID or Web Serial exists. */
export function DirectScannerConnection() {
  const { hid, serial } = useDeviceScanControls();
  const profiles = useScannerProfiles(defaultStorage());
  const [open, setOpen] = useState(false);
  if (Platform.OS !== 'web' || (!hid.available && !serial.available)) return null;
  async function remove(deviceKey: string) {
    const holder = [hid, serial].find((control) => control.connectedDeviceKey === deviceKey);
    if (holder) await holder.disconnect();
    forgetScannerProfile(defaultStorage(), deviceKey);
  }
  return <View testID="settings-scanner-direct" className="gap-3 border-t border-border pt-4">
    <SettingsRow label="Direct connection" className="px-0 py-0" action={<View className="flex-row flex-wrap items-center justify-end gap-3">
      {profiles.length === 0 ? <Text className="text-sm text-muted-foreground">None</Text> : null}
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)} className={buttonClass}>
        <Text className="text-foreground">Connect a scanner directly (advanced)</Text>
      </Pressable>
    </View>} />
    {open ? <View className="gap-3">
      <Text className="text-sm text-muted-foreground">A direct connection identifies scans by the device itself instead of by typing speed. The scanner must first be switched out of keyboard mode using a barcode from its manual.</Text>
      <View className="flex-row flex-wrap gap-3">
        {hid.available ? <Pressable accessibilityRole="button" onPress={() => { void hid.connect(); }} className={buttonClass}>
          <Text className="text-foreground">Connect over USB</Text>
        </Pressable> : null}
        {serial.available ? <Pressable accessibilityRole="button" onPress={() => { void serial.connect(); }} className={buttonClass}>
          <Text className="text-foreground">Connect over Bluetooth serial</Text>
        </Pressable> : null}
      </View>
      <Text className="text-sm text-muted-foreground">Scanners in keyboard mode can't be connected directly. That's an operating-system restriction, not a POS one. They still scan into the POS normally.</Text>
    </View> : null}
    {profiles.map((profile) => {
      const label = profile.name || profile.deviceName || 'Scanner';
      const connected = profile.deviceKey === hid.connectedDeviceKey || profile.deviceKey === serial.connectedDeviceKey;
      return <View key={profile.deviceKey} className="flex-row items-center gap-3">
        <View className="flex-1">
          <Text className="text-foreground">{label}</Text>
          <Text className="text-sm text-muted-foreground">{connected ? 'Connected' : 'Not connected'}</Text>
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${label}`} onPress={() => { void remove(profile.deviceKey); }} className={buttonClass}>
          <Text className="text-foreground">Remove</Text>
        </Pressable>
      </View>;
    })}
  </View>;
}
