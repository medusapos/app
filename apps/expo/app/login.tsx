import { useState } from 'react';
import { Platform, Pressable, Text, TextInput, View } from 'react-native';
import { Redirect, router, Stack } from 'expo-router';
import { version as appVersion } from '../package.json';
import { storeConfig } from '../lib/config';
import { feedbackUrl, openFeedbackUrl } from '../lib/feedback-url';
import { loginErrorMessage } from '../lib/login-errors';
import { useSession } from '../lib/session-context';

export default function LoginScreen() {
  const { session, signIn, signOutNotice } = useSession();
  const [baseUrl, setBaseUrl] = useState(storeConfig.defaultBaseUrl);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disabled = signingIn || !baseUrl.trim() || !email.trim() || !password;

  async function submit() {
    setSigningIn(true);
    setError(null);
    try {
      await signIn(baseUrl, email, password);
      setPassword('');
      router.replace('/');
    } catch (err) {
      setError(loginErrorMessage(err));
    } finally {
      setSigningIn(false);
    }
  }

  // The gate remounts the Stack after sign-in; that remount must not land back here.
  if (session) return <Redirect href="/" />;

  return (
    <View className="flex-1 justify-center bg-background px-6">
      <Stack.Screen options={{ title: 'Sign in' }} />
      <View className="w-full max-w-md self-center gap-3 rounded-md border border-border bg-card p-6">
        <Text className="text-foreground">Backend URL</Text>
        <TextInput accessibilityLabel="Backend URL" value={baseUrl} onChangeText={setBaseUrl}
          autoCapitalize="none" autoCorrect={false} keyboardType="url"
          className="rounded-md border border-border px-3 py-2 text-foreground" />
        <Text className="text-foreground">Email</Text>
        <TextInput accessibilityLabel="Email" value={email} onChangeText={setEmail}
          autoCapitalize="none" autoCorrect={false} keyboardType="email-address"
          className="rounded-md border border-border px-3 py-2 text-foreground" />
        <Text className="text-foreground">Password</Text>
        <TextInput accessibilityLabel="Password" value={password} onChangeText={setPassword}
          secureTextEntry autoCapitalize="none" autoCorrect={false}
          className="rounded-md border border-border px-3 py-2 text-foreground" />
        {error ?? signOutNotice ? <Text className="text-sm text-destructive">{error ?? signOutNotice}</Text> : null}
        <Pressable accessibilityRole="button" disabled={disabled} onPress={submit}
          className={`rounded-md bg-primary px-4 py-3 ${disabled ? 'opacity-50' : ''}`}>
          <Text className="text-center font-semibold text-primary-foreground">Sign in</Text>
        </Pressable>
        {storeConfig.demo ? <Pressable accessibilityRole="link" onPress={() => router.push('/demo')} className="min-h-11 justify-center">
          <Text className="text-center text-sm text-muted-foreground">Try the demo</Text>
        </Pressable> : null}
        <Pressable accessibilityRole="link" className="min-h-11 justify-center" onPress={() => { openFeedbackUrl(feedbackUrl({
          appVersion, platform: Platform.OS,
          userAgent: Platform.OS === 'web' ? navigator.userAgent : undefined,
          backendUrl: baseUrl,
        })); }}>
          <Text className="text-center text-sm text-muted-foreground">Send feedback</Text>
        </Pressable>
      </View>
    </View>
  );
}
