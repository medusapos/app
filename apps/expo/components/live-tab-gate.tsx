import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Platform, Text, View } from 'react-native';
import {
  startLiveTab as startLiveTabDefault,
  type LiveTabHandle, type LiveTabOptions, type LiveTabState,
} from '@tallyui/database';
import { LiveTabScreen } from '@tallyui/components';
import { closeDatabases, isBusy } from '../lib/live-tab';

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
  const showChildrenRef = useRef(false);
  const committedResolveRef = useRef<(() => void) | null>(null);
  const unmountedRef = useRef(false);
  const handleRef = useRef<LiveTabHandle | null>(null);
  // The in-flight park's closeDatabases(), if any. On `pagehide` the coordinator
  // emits `parked` before `onPark` runs and can go `live` again (via `pageshow`)
  // before that `onPark` settles, so a `live` must wait for this rather than
  // assume it always follows a settled park (true only for the take-over path).
  const parkCloseRef = useRef<Promise<void> | null>(null);

  useEffect(() => () => { unmountedRef.current = true; }, []);

  // Resolves whoever is waiting for children to unmount, once that unmount
  // (or remount) has committed: children's own effect cleanups have already run.
  useEffect(() => {
    committedResolveRef.current?.();
    committedResolveRef.current = null;
  }, [showChildren]);

  useEffect(() => {
    if (!scope || Platform.OS !== 'web') return undefined;
    setState('acquiring');
    showChildrenRef.current = false;
    setShowChildren(false);
    let disposed = false;

    const hideChildren = (): Promise<void> => {
      if (!showChildrenRef.current || unmountedRef.current) return Promise.resolve();
      showChildrenRef.current = false;
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
          // Never hangs: closeDatabases() itself never rejects (its own pieces
          // close best-effort), but settle either way rather than assume.
          void pending.finally(() => {
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
    };
  }, [scope, startLiveTab]);

  if (!scope || Platform.OS !== 'web') return <>{children}</>;
  if (state === 'live' && showChildren) return <>{children}</>;
  if (state === 'parked' || state === 'blocked') {
    return (
      <LiveTabScreen
        state={state}
        onUseHere={() => { void handleRef.current?.takeOver(); }}
        onReload={() => window.location.reload()}
        parkedTitle="MedusaPOS is open in another tab"
        parkedBody="This tab stopped so the other one can take sales. Use MedusaPOS here instead?"
        useHereLabel="Use here"
        blockedBody="MedusaPOS is open in another tab. Close that tab to use it here, or reload this one."
        reloadLabel="Reload"
      />
    );
  }
  return (
    <View className="flex-1 items-center justify-center">
      <Text className="text-muted-foreground">Opening MedusaPOS…</Text>
    </View>
  );
}
