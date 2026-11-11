import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Platform, View } from 'react-native';
import type { MangoQuerySelector, RxCollection } from 'rxdb';
import { Button, Dialog, DialogContent, DialogTitle, Input, Label, SettingsGroup, Text } from '@tallyui/components';
import {
  CLEAR_BODY, CLEAR_CONFIRM_WORD, CLEAR_FLAG_KEY, clearAllLocalData, clearWarnings, defaultClearDeps, isClearPending, reloadPage,
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
      <Text className="text-foreground">Some local data may already be deleted.</Text>
      {/* The flag is still set, so the reload retries the wipe. */}
      <Button testID="clear-local-data-retry" className="min-h-11" onPress={() => reloadPage()}><Text>Reload and retry</Text></Button>
      {/* A wipe that always fails is never a dead end: without the flag the app opens with what is left. */}
      <Button variant="outline" testID="clear-local-data-cancel-reset" className="min-h-11"
        onPress={() => { defaultStorage()?.removeItem(CLEAR_FLAG_KEY); reloadPage(); }}><Text>Cancel reset</Text></Button>
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

const EVERY = {};
const NOT_APPLIED = { syncStatus: { $ne: 'applied' } };
// The order outbox's own count selectors (TallyUI 3.8.0 order-outbox.ts), read live instead of its initial zero state.
const PENDING = { syncStatus: 'pending' };
const REJECTED = { syncStatus: 'rejected' };

/** Live, read only: null with no collection or before its first result (find().$, as count() needs a full index). */
function useLiveCount(collection: RxCollection | undefined, selector: MangoQuerySelector<any>): number | null {
  const [count, setCount] = useState<{ of: RxCollection; n: number } | null>(null);
  useEffect(() => {
    if (!collection) return;
    const subscription = collection.find({ selector }).$.subscribe((docs) => setCount({ of: collection, n: docs.length }));
    return () => subscription.unsubscribe();
  }, [collection, selector]);
  return collection && count?.of === collection ? count.n : null;
}

function ClearLocalDataDialog({ onClose }: { onClose: () => void }) {
  // Read live: a sale or till entry queued while the dialog is open updates the lines and the gate.
  const { savesInFlight, orders } = useOutboxContext();
  const { register } = useRegister();
  const { session } = useSession();
  const [word, setWord] = useState('');
  const status = register.session?.status;
  const registerContract = session?.capabilities?.register ?? 0;
  const collections = orders?.database.collections as Record<string, RxCollection> | undefined;
  // Every drafts document is a parked sale (useParkedSales); the sale on screen is never kept there.
  const parked = useLiveCount(collections?.drafts, EVERY);
  // Pending and refused: the register outbox (TallyUI 3.8.0) counts only pending.
  const tillEntries = useLiveCount(collections?.register_commands, NOT_APPLIED);
  const closures = useLiveCount(registerContract === 0 ? collections?.closures : undefined, EVERY);
  const pending = useLiveCount(orders ?? undefined, PENDING);
  const rejected = useLiveCount(orders ?? undefined, REJECTED);
  const { lines, atRisk } = clearWarnings({
    sales: pending === null || rejected === null ? null : pending + rejected + savesInFlight,
    parked, tillEntries, localClosures: registerContract === 0 ? closures : 0,
    tillOpen: status === 'open' || status === 'counting',
    registerContract,
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
