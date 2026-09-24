import { useState } from 'react';
import { Platform, Pressable, Text, TextInput, View } from 'react-native';
import * as Linking from 'expo-linking';
import { router, Stack } from 'expo-router';
import { version as appVersion } from '../package.json';
import { storeConfig } from '../lib/config';
import { feedbackUrl } from '../lib/feedback-url';
import { LoginError, type LoginErrorCode } from '../lib/session';
import { useSession } from '../lib/session-context';

const ERROR_MESSAGES: Record<LoginErrorCode, string> = {
  invalid_credentials: 'Incorrect email or password.',
  unsupported_account: 'This account needs multi-factor authentication or verification, which the POS does not support yet.',
  unreachable: 'Could not reach the backend. Check the URL and your connection.',
  server_error: 'The backend could not sign you in. Please try again.',
  invalid_url: 'Enter a valid backend URL starting with https://.',
  insecure_url: 'Use https://. Plain http:// is only allowed for localhost and private network addresses.',
};

export default function LoginScreen() {
  const { signIn } = useSession();
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
      setError(ERROR_MESSAGES[err instanceof LoginError ? err.code : 'server_error']);
    } finally {
      setSigningIn(false);
    }
  }

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
        {error ? <Text className="text-sm text-destructive">{error}</Text> : null}
        <Pressable accessibilityRole="button" disabled={disabled} onPress={submit}
          className={`rounded-md bg-primary px-4 py-3 ${disabled ? 'opacity-50' : ''}`}>
          <Text className="text-center font-semibold text-primary-foreground">Sign in</Text>
        </Pressable>
        <Pressable accessibilityRole="link" onPress={() => { void Linking.openURL(feedbackUrl({
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
