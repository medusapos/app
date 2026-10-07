import { useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import * as Linking from 'expo-linking';
import { DEMO_ABOUT_URL, DEMO_QUICK_START_URL, DEMO_REPO_URL, isDemoAccount } from '../lib/demo';
import { useSession } from '../lib/session-context';

function openUrl(url: string): void {
  if (Platform.OS === 'web') window.open(url, '_blank', 'noopener,noreferrer');
  else void Linking.openURL(url).catch((error) => console.warn('Failed to open demo URL:', error));
}

// Shown only to the public demo accounts in demo mode, never on app.*.
export function DemoBanner() {
  const { session } = useSession();
  const [dismissed, setDismissed] = useState(false);

  if (!session || !isDemoAccount(session.email) || dismissed) return null;

  return (
    <View testID="demo-banner" dataSet={{ print: 'hide' }} className="flex-row flex-wrap items-center gap-x-4 border-b border-border bg-background px-4 py-2">
      <Text className="text-sm text-muted-foreground">MedusaPOS demo</Text>
      <Pressable accessibilityRole="link" testID="demo-banner-site" onPress={() => openUrl(DEMO_ABOUT_URL)} className="min-h-11 justify-center">
        <Text className="text-sm text-foreground">About MedusaPOS</Text>
      </Pressable>
      <Pressable accessibilityRole="link" testID="demo-banner-quick-start" onPress={() => openUrl(DEMO_QUICK_START_URL)} className="min-h-11 justify-center">
        <Text className="text-sm text-foreground">Quick start</Text>
      </Pressable>
      <Pressable accessibilityRole="link" testID="demo-banner-github" onPress={() => openUrl(DEMO_REPO_URL)} className="min-h-11 justify-center">
        <Text className="text-sm text-foreground">GitHub</Text>
      </Pressable>
      <Pressable accessibilityRole="button" testID="demo-banner-dismiss" onPress={() => setDismissed(true)} className="min-h-11 justify-center">
        <Text className="text-sm text-foreground">Dismiss</Text>
      </Pressable>
    </View>
  );
}
