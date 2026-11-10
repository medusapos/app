import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Platform, View } from 'react-native';
import { Button, Dialog, DialogContent, DialogTitle, SettingsGroup, Text } from '@tallyui/components';
import {
  CLEAR_BODY, clearAllLocalData, defaultClearDeps, isClearPending, reloadPage, requestClearLocalData, unsentWarning,
} from '../lib/clear-local-data';
import { useOutboxContext } from '../lib/outbox-context';
import { defaultStorage } from '../lib/session';

/** Above SessionProvider: with the clear flag set (web), wipes local data before the app renders, then reloads. */
export function ClearLocalDataGate({ children }: { children: ReactNode }) {
  // Read once: the wipe removes the flag, and nothing below may render before the reload.
  const [pending] = useState(() => Platform.OS === 'web' && isClearPending(defaultStorage()));
  const [failed, setFailed] = useState(false);
  // StrictMode runs the effect twice; one wipe only.
  const started = useRef(false);
  useEffect(() => {
    if (!pending || started.current) return;
    started.current = true;
    clearAllLocalData(defaultClearDeps()).then(() => reloadPage(), (error: unknown) => {
      console.warn('Could not clear local data:', error);
      setFailed(true);
    });
  }, [pending]);
  if (!pending) return <>{children}</>;
  return <View className="flex-1 items-center justify-center gap-4 bg-background px-6">
    {failed ? <>
      <Text testID="clear-local-data-failed" accessibilityRole="header" className="text-lg font-semibold text-foreground">Reset didn't finish</Text>
      <Text className="text-foreground">Close every other tab of this app, then reload and retry.</Text>
      {/* The flag is still set, so the reload retries the wipe. */}
      <Button testID="clear-local-data-retry" className="min-h-11" onPress={() => reloadPage()}><Text>Reload and retry</Text></Button>
    </> : <Text testID="clear-local-data-progress" className="text-foreground">Clearing local data…</Text>}
  </View>;
}

/** Settings › Danger zone (web only: native storage is in memory). Warns, never refuses (WCPOS v2). */
export function ClearLocalDataSection() {
  const [open, setOpen] = useState(false);
  if (Platform.OS !== 'web') return null;
  return <SettingsGroup title="Danger zone" testID="settings-danger">
    <View className="gap-4 p-4">
      <Text className="text-sm text-foreground">{CLEAR_BODY}</Text>
      <View className="flex-row">
        <Button variant="destructive" testID="clear-local-data" className="min-h-11" onPress={() => setOpen(true)}>
          <Text>Clear all local data</Text>
        </Button>
      </View>
    </View>
    {open ? <ClearLocalDataDialog onClose={() => setOpen(false)} /> : null}
  </SettingsGroup>;
}

function ClearLocalDataDialog({ onClose }: { onClose: () => void }) {
  const { state, savesInFlight } = useOutboxContext();
  return <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
    <DialogContent testID="clear-local-data-dialog">
      <DialogTitle>Clear all local data?</DialogTitle>
      <Text testID="clear-local-data-warning">{unsentWarning(state.pending + savesInFlight)}</Text>
      <Text>{CLEAR_BODY}</Text>
      <Button variant="destructive" testID="clear-local-data-confirm" className="min-h-11" onPress={() => requestClearLocalData(localStorage)}>
        <Text>Clear all local data</Text>
      </Button>
      <Button variant="outline" testID="clear-local-data-cancel" className="min-h-11" onPress={onClose}>
        <Text>Cancel</Text>
      </Button>
    </DialogContent>
  </Dialog>;
}
