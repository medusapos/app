import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Platform, Text, View } from 'react-native';
import {
  startLiveTab as startLiveTabDefault,
  type LiveTabHandle, type LiveTabOptions, type LiveTabState,
} from '@tallyui/database';
import { LiveTabScreen } from '@tallyui/components';
import { closeDatabases, isBusy, storageNeedsReload, storageStartFailed$ } from '../lib/live-tab';
import { UnsupportedStorageError, webStorageAvailable } from '../lib/web-storage';

export interface LiveTabGateProps {
  /** Store scope for the coordinator; no scope (signed out) starts nothing. */
  scope?: string;
  children: ReactNode;
  /** Injection for tests; defaults to `startLiveTab` from `@tallyui/database`. */
  startLiveTab?: (options: LiveTabOptions) => LiveTabHandle;
}

/**
 * ADR-061: exactly one live tab per store. Wraps `startLiveTab` /
 * `LiveTabScreen` from TallyUI so the POS renders only on the tab that holds
 * the lock, and hands over cleanly to a new tab.
 */
export function LiveTabGate({ scope, children, startLiveTab = startLiveTabDefault }: LiveTabGateProps) {
  const [state, setState] = useState<LiveTabState>('acquiring');
  const [showChildren, setShowChildren] = useState(false);
  // A StorageWorkerStartError at open (e.g. the opfs-sahpool pool held elsewhere): see below.
  const [storageStartFailed, setStorageStartFailed] = useState(false);
  const showChildrenRef = useRef(false);
  // Last-committed `showChildren`, updated by the effect below (after a real
  // commit) — unlike `showChildrenRef`, immune to a same-batch true+false no-op.
  const committedShowChildrenRef = useRef(false);
  const committedResolveRef = useRef<(() => void) | null>(null);
  const unmountedRef = useRef(false);
  const handleRef = useRef<LiveTabHandle | null>(null);
  // The scope `state`/`showChildren` belong to, set together with them at the
  // top of the effect below. The render checks this before trusting
  // `state`/`showChildren`, so a stale `live` + showChildren left over from a
  // previous scope (e.g. sign-out then straight back in) can never be read for
  // a new scope before that scope's own coordinator says so.
  const ownerScopeRef = useRef<string | undefined>(undefined);
  // The in-flight park's closeDatabases(), if any. On `pagehide` the coordinator
  // emits `parked` before `onPark` runs and can go `live` again (via `pageshow`)
  // before that `onPark` settles, so a `live` must wait for this rather than
  // assume it always follows a settled park (true only for the take-over path).
  const parkCloseRef = useRef<Promise<void> | null>(null);

  useEffect(() => () => { unmountedRef.current = true; }, []);

  useEffect(() => {
    const subscription = storageStartFailed$.subscribe(setStorageStartFailed);
    return () => subscription.unsubscribe();
  }, []);

  // Layout effects run synchronously in the commit, before any passive effect
  // anywhere in the tree (including a just-mounted child's own mount effect),
  // so `onPark` can never read a commit that hasn't actually happened yet.
  useLayoutEffect(() => {
    committedShowChildrenRef.current = showChildren;
  }, [showChildren]);

  // Resolves whoever is waiting for children to unmount, once that unmount
  // (or remount) has committed: children's own effect cleanups have already run.
  useEffect(() => {
    committedResolveRef.current?.();
    committedResolveRef.current = null;
  }, [showChildren]);

  // Web without SQLite-wasm (plain http on a LAN IP, an old browser): sales would only live in
  // memory, so the coordinator never starts and nothing opens; a screen says why instead.
  const unsupported = !!scope && Platform.OS === 'web' && !webStorageAvailable();

  useEffect(() => {
    if (!scope || Platform.OS !== 'web' || unsupported) return undefined;
    ownerScopeRef.current = scope;
    setState('acquiring');
    showChildrenRef.current = false;
    setShowChildren(false);
    let disposed = false;

    const hideChildren = (): Promise<void> => {
      if (!showChildrenRef.current || unmountedRef.current) return Promise.resolve();
      showChildrenRef.current = false;
      // Same-batch true+false is a no-op against the previous commit: nothing
      // to wait for, just keep the pending `true` from landing.
      if (!committedShowChildrenRef.current) {
        setShowChildren(false);
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        committedResolveRef.current = resolve;
        setShowChildren(false);
      });
    };

    const handle = startLiveTab({
      scope,
      maxDeferMs: 10_000,
      isBusy,
      onPark: async () => {
        // (1) Stop rendering children so the POS unmounts and its own effect
        // cleanups stop the outbox, replication and runners; (2) wait for that
        // unmount to commit; (3) close what is left open.
        await hideChildren();
        const closing = closeDatabases();
        parkCloseRef.current = closing;
        await closing;
      },
    });
    handleRef.current = handle;
    const subscription = handle.state$.subscribe((next) => {
      setState(next);
      if (next === 'live') {
        const pending = parkCloseRef.current;
        parkCloseRef.current = null;
        if (pending) {
          // Never leaves an unhandled rejection: closeDatabases() can reject (a
          // real close() failing), but the POS remounts either way once the
          // park settles.
          void pending.catch(() => {}).finally(() => {
            if (disposed) return;
            showChildrenRef.current = true;
            setShowChildren(true);
          });
        } else {
          showChildrenRef.current = true;
          setShowChildren(true);
        }
      }
    });

    return () => {
      disposed = true;
      subscription.unsubscribe();
      handle.stop();
      if (handleRef.current === handle) handleRef.current = null;
      // Drop ownership before the next render (sign-out, or a scope change):
      // otherwise re-entering the same scope reads this effect's own stale
      // `state`/`showChildren` as already owned.
      ownerScopeRef.current = undefined;
    };
  }, [scope, startLiveTab, unsupported]);

  // Shared by the coordinator's own parked/blocked screen and the storage-start-failure override.
  const renderParkedOrBlocked = (s: 'parked' | 'blocked', title = 'MedusaPOS is open in another tab') => {
    // A prior park's closes outran PARK_CLOSE_LIMIT_MS (live-tab.ts): this tab's
    // database names are stuck taken, so "Use here" would only hang; reload instead.
    const parkedNeedsReload = s === 'parked' && storageNeedsReload();
    return (
      <LiveTabScreen
        state={s}
        onUseHere={parkedNeedsReload ? () => window.location.reload() : () => { void handleRef.current?.takeOver(); }}
        onReload={() => window.location.reload()}
        parkedTitle={title}
        parkedBody={parkedNeedsReload
          ? 'Reload this tab to use MedusaPOS here.'
          : 'This tab stopped so the other one can take sales. Use MedusaPOS here instead?'}
        useHereLabel={parkedNeedsReload ? 'Reload' : 'Use here'}
        blockedBody="MedusaPOS is open in another tab. Close that tab to use it here, or reload this one."
        reloadLabel="Reload"
      />
    );
  };

  if (!scope || Platform.OS !== 'web') return <>{children}</>;
  if (unsupported) {
    return (
      <LiveTabScreen
        state="blocked"
        onUseHere={() => window.location.reload()}
        onReload={() => window.location.reload()}
        parkedTitle="MedusaPOS can't run in this browser"
        blockedBody={new UnsupportedStorageError().message}
        reloadLabel="Reload"
      />
    );
  }
  // ADR-061: shows the blocked screen whatever the coordinator state; the lock stays held, and
  // reload (below) is the recovery, same as a genuinely blocked coordinator.
  if (storageStartFailed) return renderParkedOrBlocked('blocked');
  const owned = ownerScopeRef.current === scope;
  // Live again (e.g. `pageshow` after a `pagehide` park) with names a park's closes left stuck:
  // opening the POS would hang on them, so the parked screen's Reload shows instead.
  if (owned && state === 'live' && showChildren) {
    return storageNeedsReload() ? renderParkedOrBlocked('parked', 'MedusaPOS needs a reload') : <>{children}</>;
  }
  if (owned && (state === 'parked' || state === 'blocked')) return renderParkedOrBlocked(state);
  return (
    <View className="flex-1 items-center justify-center">
      <Text className="text-muted-foreground">Opening MedusaPOS…</Text>
    </View>
  );
}
