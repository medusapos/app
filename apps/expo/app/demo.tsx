import { useEffect, useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import * as Linking from 'expo-linking';
import { Redirect, router, Stack } from 'expo-router';
import { storeConfig } from '../lib/config';
import { DEMO_ABOUT_URL, DEMO_ACCOUNTS, DEMO_QUICK_START_URL, DEMO_WHAT_TO_TRY } from '../lib/demo';
import { trackDemoEvent } from '../lib/demo-analytics';
import { loginErrorMessage } from '../lib/login-errors';
import { useSession } from '../lib/session-context';

function openDemoUrl(url: string): void {
  if (Platform.OS === 'web') window.open(url, '_blank', 'noopener,noreferrer');
  else void Linking.openURL(url).catch((error) => console.warn('Failed to open demo URL:', error));
}

export default function DemoScreen() {
  const { session, signIn } = useSession();
  const [signingIn, setSigningIn] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (storeConfig.demo && !session) trackDemoEvent('demo_opened');
  }, []);

  async function submit(email: string, password: string) {
    setSigningIn(email);
    setError(null);
    try {
      await signIn(storeConfig.defaultBaseUrl, email, password);
      trackDemoEvent('demo_signed_in');
      router.replace('/');
    } catch (err) {
      setError(loginErrorMessage(err));
    } finally {
      setSigningIn(null);
    }
  }

  if (!storeConfig.demo) return <Redirect href="/login" />;
  // The gate remounts the Stack after sign-in; that remount must not land back here.
  if (session) return <Redirect href="/" />;

  return (
    <View className="flex-1 justify-center bg-background px-6">
      <Stack.Screen options={{ title: 'MedusaPOS demo – try the point of sale in one click' }} />
      <View className="w-full max-w-md self-center gap-4 rounded-md border border-border bg-card p-6">
        <Text accessibilityRole="header" aria-level={1} className="text-xl font-semibold text-foreground">Medusa POS demo store</Text>
        <Text className="text-foreground">This is a public demo store, data resets nightly.</Text>
        {DEMO_ACCOUNTS.map((account, index) => <View key={account.email} className="gap-2">
          <Pressable accessibilityRole="button" testID={account.testID} disabled={signingIn !== null} onPress={() => submit(account.email, account.password)}
            className={`w-full min-h-11 rounded-md px-4 py-3 ${index === 0 ? 'bg-primary' : 'border border-border bg-card'} ${signingIn !== null ? 'opacity-50' : ''}`}>
            <Text className={`text-center font-semibold ${index === 0 ? 'text-primary-foreground' : 'text-foreground'}`}>
              {signingIn === account.email ? 'Entering…' : account.label}
            </Text>
          </Pressable>
          <Text selectable className="text-sm text-muted-foreground">{account.email} · {account.password}</Text>
        </View>)}
        {error ? <Text accessibilityRole="alert" className="text-sm text-destructive">{error}</Text> : null}
        <View className="gap-2">
          <Text accessibilityRole="header" aria-level={2} className="font-semibold text-foreground">What to try</Text>
          {DEMO_WHAT_TO_TRY.map((item) => <Text key={item} className="text-foreground">• {item}</Text>)}
        </View>
        <View className="flex-row items-center gap-4">
          <Pressable accessibilityRole="link" onPress={() => openDemoUrl(DEMO_ABOUT_URL)} className="min-h-11 justify-center">
            <Text className="text-sm text-foreground">About MedusaPOS</Text>
          </Pressable>
          <Pressable accessibilityRole="link" testID="demo-quick-start" onPress={() => openDemoUrl(DEMO_QUICK_START_URL)} className="min-h-11 justify-center">
            <Text className="text-sm text-foreground">Quick start</Text>
          </Pressable>
        </View>
        <Pressable accessibilityRole="link" onPress={() => router.push('/login')} className="min-h-11 justify-center">
          <Text className="text-center text-sm text-foreground">Sign in with another account</Text>
        </Pressable>
      </View>
    </View>
  );
}
