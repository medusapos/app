// v2's amber "Device went offline" toast on the Sale screen (DEMO-PARITY row 19).
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, View } from 'react-native';
import { Path } from 'react-native-svg';
import { Button, createSvgIcon, Text, Toast, ToastClose, ToastDescription, ToastTitle } from '@tallyui/components';
import type { SyncState } from '../lib/use-replicated-products';
import { CheckCircleIcon } from './customer-saved-toast';

// v2's CONNECTIVITY_SETTLE_MS: an outage must last this long before the toast shows, so a blip shows nothing.
export const OFFLINE_TOAST_DELAY_MS = 5_000;
// Matches how long the app's other passing toasts stay visible.
export const RESTORED_TOAST_MS = 3_000;
// The offline section of MedusaPOS's own docs, which the toast's Help button opens.
export const OFFLINE_HELP_URL = 'https://medusapos.com/docs/troubleshooting#sell-offline';

export type OfflineKind = 'device' | 'store';

const TITLE: Record<OfflineKind, string> = { device: 'Device went offline', store: 'Website is unreachable' };

/**
 * The toast's state: `kind` once an outage (the device's network gone, or the store not answering the pull) has
 * lasted OFFLINE_TOAST_DELAY_MS, else null. A switch between the two kinds inside one outage keeps the wait; `close()`
 * hides it for the rest of the outage, and the next outage shows it again after a fresh wait.
 */
export function useOfflineToast(networkOnline: boolean, pullState: SyncState): { kind: OfflineKind | null; close: () => void; restored: boolean } {
  const now: OfflineKind | null = !networkOnline ? 'device' : pullState === 'offline' ? 'store' : null;
  const outage = now !== null;
  const [settled, setSettled] = useState(false);
  const [closed, setClosed] = useState(false);
  const [restored, setRestored] = useState(false);
  const hadSettledOutage = useRef(false);
  useEffect(() => {
    if (outage) {
      setRestored(false);
      const timer = setTimeout(() => {
        hadSettledOutage.current = true;
        setSettled(true);
      }, OFFLINE_TOAST_DELAY_MS);
      return () => clearTimeout(timer);
    }
    setSettled(false);
    setClosed(false);
    if (!hadSettledOutage.current) return;
    let timer = setTimeout(() => {
      hadSettledOutage.current = false;
      setRestored(true);
      timer = setTimeout(() => setRestored(false), RESTORED_TOAST_MS);
    }, OFFLINE_TOAST_DELAY_MS);
    return () => clearTimeout(timer);
  }, [outage]);
  const close = useCallback(() => setClosed(true), []);
  return { kind: outage && settled && !closed ? now : null, close, restored: !outage && restored };
}

export const WarningIcon = createSvgIcon('WarningIcon', () => <>
  <Path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
  <Path d="M12 9v4M12 17h.01" />
</>);

// As medusa-admin.ts opens a URL: a new browser tab on web, the system browser on native (expo-linking on demand).
function openHelp(): void {
  if (Platform.OS === 'web') window.open(OFFLINE_HELP_URL, '_blank', 'noopener,noreferrer');
  else void import('expo-linking').then((Linking) => Linking.openURL(OFFLINE_HELP_URL))
    .catch((error) => console.warn('Failed to open help URL:', error));
}

export function OfflineToast({ kind, onClose }: { kind: OfflineKind; onClose: () => void }) {
  // An opaque surface with an amber layer on it: the toast floats over the products, which must not show through.
  return <Toast testID="offline-toast" accessibilityRole="alert"
    className="max-w-md gap-3 border-warning bg-background p-3 pr-10">
    <View pointerEvents="none" className="absolute inset-0 bg-warning/15" />
    <View className="text-warning"><WarningIcon size={24} /></View>
    <View className="flex-1">
      <ToastTitle className="text-foreground">{TITLE[kind]}</ToastTitle>
      <ToastDescription className="text-foreground">Keep working — sync resumes when the store is reachable.</ToastDescription>
    </View>
    <Button size="sm" variant="default" testID="offline-toast-help" onPress={openHelp}><Text>Help</Text></Button>
    <ToastClose className="opacity-100" accessibilityLabel="Close" testID="offline-toast-close" onPress={onClose} />
  </Toast>;
}

export function RestoredToast() {
  return <Toast testID="connection-restored-toast" accessibilityLiveRegion="polite"
    className="max-w-md gap-3 border-success bg-background p-3">
    <View pointerEvents="none" className="absolute inset-0 bg-success/15" />
    <View className="text-success"><CheckCircleIcon size={24} /></View>
    <View className="flex-1">
      <ToastTitle className="text-foreground">Connection restored</ToastTitle>
    </View>
  </Toast>;
}
