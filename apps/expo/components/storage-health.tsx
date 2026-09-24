import { useEffect, useState, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { storageHealth$ } from '../lib/storage-health';

/**
 * ADR-061: shows the local storage's health over `children`, mounted in `_layout.tsx` inside
 * `LiveTabGate`, around `OutboxProvider`. `stalled` keeps the children with a small
 * non-blocking note; `dead` replaces them with a reload prompt — sticky, since reload is the
 * only recovery for a dead worker.
 */
export function StorageHealth({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<'ok' | 'stalled' | 'dead'>('ok');
  useEffect(() => {
    const subscription = storageHealth$.subscribe(setStatus);
    return () => subscription.unsubscribe();
  }, []);

  if (status === 'dead') {
    return (
      <View className="flex-1 items-center justify-center gap-4 bg-bg p-6">
        <Text className="text-center text-lg font-bold text-foreground">Storage stopped</Text>
        <Text className="text-center text-sm text-muted-foreground">
          MedusaPOS can&apos;t save on this device right now. Reload to continue; sales already saved are kept.
        </Text>
        <Pressable accessibilityRole="button" onPress={() => window.location.reload()}
          className="items-center rounded-lg bg-primary px-4 py-3">
          <Text className="text-sm font-semibold text-primary-foreground">Reload</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <>
      {status === 'stalled' && (
        <Text accessibilityRole="alert" className="bg-card px-4 py-1 text-center text-xs text-muted-foreground">
          Saving is slow…
        </Text>
      )}
      {children}
    </>
  );
}
