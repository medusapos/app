import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Platform, View } from 'react-native';
import { Button, Dialog, DialogContent, DialogTitle, Input, Label, SettingsGroup, Text } from '@tallyui/components';
import {
  CLEAR_BODY, CLEAR_CONFIRM_WORD, clearAllLocalData, clearWarnings, defaultClearDeps, isClearPending, reloadPage,
  requestClearLocalData,
} from '../lib/clear-local-data';
import { useOutboxContext } from '../lib/outbox-context';
import { useRegister } from '../lib/register-context';
import { defaultStorage } from '../lib/session';
import { useSession } from '../lib/session-context';

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
  // Read live: a sale or till entry queued while the dialog is open updates the lines and the gate.
  const { state, savesInFlight } = useOutboxContext();
  const { register, registerOutbox } = useRegister();
  const { session } = useSession();
  const [word, setWord] = useState('');
  const status = register.session?.status;
  const { lines, atRisk } = clearWarnings({
    sales: state.pending + (state.rejected ?? 0) + savesInFlight,
    tillEntries: registerOutbox.state.pending,
    tillOpen: status === 'open' || status === 'counting',
    registerContract: session?.capabilities?.register ?? 0,
  });
  const locked = atRisk && word.trim().toUpperCase() !== CLEAR_CONFIRM_WORD;
  const prompt = `Type ${CLEAR_CONFIRM_WORD} to confirm`;
  return <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
    <DialogContent testID="clear-local-data-dialog">
      <DialogTitle>Clear all local data?</DialogTitle>
      {lines.map((line, i) => <Text key={i} testID={i === 0 ? 'clear-local-data-warning' : `clear-local-data-warning-${i}`}>{line}</Text>)}
      <Text>{CLEAR_BODY}</Text>
      {atRisk ? <>
        <Label nativeID="clear-local-data-word-label">{prompt}</Label>
        <Input><Input.Field testID="clear-local-data-word" value={word} onChangeText={setWord} autoCapitalize="characters" autoComplete="off"
          accessibilityLabel={prompt} accessibilityLabelledBy="clear-local-data-word-label" /></Input>
      </> : null}
      <Button variant="destructive" testID="clear-local-data-confirm" className="min-h-11" disabled={locked}
        onPress={() => { if (!locked) requestClearLocalData(localStorage); }}>
        <Text>Clear all local data</Text>
      </Button>
      <Button variant="outline" testID="clear-local-data-cancel" className="min-h-11" onPress={onClose}>
        <Text>Cancel</Text>
      </Button>
    </DialogContent>
  </Dialog>;
}
