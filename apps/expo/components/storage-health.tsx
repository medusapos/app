import { useEffect, useState, type ReactNode } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { version as appVersion } from '../package.json';
import { feedbackUrl, openFeedbackUrl } from '../lib/feedback-url';
import { orderStoreOpenFailed$, storageHealth$, type OrderStoreOpenFailure } from '../lib/storage-health';

/**
 * ADR-061: shows the local storage's health over `children`, mounted in `_layout.tsx` inside
 * `LiveTabGate`, around `OutboxProvider`. `stalled` keeps the children with a small
 * non-blocking note; `dead` replaces them with a reload prompt — sticky, since reload is the
 * only recovery for a dead worker. An order-store open failure also blocks, with its own prompt.
 */
export function StorageHealth({ children, backendUrl }: { children: ReactNode; backendUrl?: string }) {
  const [status, setStatus] = useState<'ok' | 'stalled' | 'dead'>('ok');
  const [openFailure, setOpenFailure] = useState<OrderStoreOpenFailure>(null);
  useEffect(() => {
    const subscription = storageHealth$.subscribe(setStatus);
    return () => subscription.unsubscribe();
  }, []);
  useEffect(() => { const sub = orderStoreOpenFailed$.subscribe(setOpenFailure); return () => sub.unsubscribe(); }, []);

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

  if (openFailure) {
    const report = () => openFeedbackUrl(feedbackUrl({
      appVersion, backendUrl, platform: Platform.OS, userAgent: Platform.OS === 'web' ? navigator.userAgent : undefined,
      errorCode: openFailure.code,
    }));
    return (
      <View className="flex-1 items-center justify-center gap-4 bg-bg p-6">
        <Text className="text-center text-lg font-bold text-foreground">Saved sales can&apos;t be opened</Text>
        <Text className="text-center text-sm text-muted-foreground">
          Saved sales can&apos;t be opened on this device. Nothing has been deleted. Reload to try again, or report the problem.
        </Text>
        {openFailure.code && (
          <Text className="text-center text-xs text-muted-foreground">Error code: {openFailure.code}</Text>
        )}
        <View className="flex-row gap-3">
          <Pressable accessibilityRole="button" onPress={() => window.location.reload()} className="items-center rounded-lg bg-primary px-4 py-3">
            <Text className="text-sm font-semibold text-primary-foreground">Reload</Text>
          </Pressable>
          <Pressable accessibilityRole="link" onPress={report} className="items-center justify-center rounded-lg px-4 py-3">
            <Text className="text-sm font-semibold text-foreground">Report a problem</Text>
          </Pressable>
        </View>
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
