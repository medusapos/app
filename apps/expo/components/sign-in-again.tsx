import { useEffect, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { useOutboxContext } from '../lib/outbox-context';
import { useSession } from '../lib/session-context';

export function SignInAgain() {
  const { session, signIn } = useSession();
  const { state, flush } = useOutboxContext();
  const [password, setPassword] = useState('');
  const [signingIn, setSigningIn] = useState(false);
  const [shouldFlush, setShouldFlush] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!shouldFlush) return;
    setShouldFlush(false);
    // Wait for the new session token to reach the outbox before sending.
    void flush();
  }, [shouldFlush, flush]);
  if (!session || !state.authRequired) return null;
  const disabled = signingIn || !password;

  async function submit() {
    if (!session) return;
    setSigningIn(true);
    setError(null);
    setPassword('');
    try {
      await signIn(session.baseUrl, session.email, password);
      setShouldFlush(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSigningIn(false);
    }
  }

  return <View className="gap-2 border-b border-border bg-card px-4 py-3">
    <Text accessibilityRole="header" className="font-semibold text-foreground">Sign in again</Text>
    <Text className="text-foreground">Your sign-in has expired, so {state.pending === 1 ? '1 sale is' : `${state.pending} sales are`} waiting to be sent. Enter the password for {session.email} to send them.</Text>
    <Text className="text-foreground">Password</Text>
    <TextInput accessibilityLabel="Password" value={password} onChangeText={setPassword}
      secureTextEntry autoCapitalize="none" autoCorrect={false}
      className="rounded-md border border-border px-3 py-2 text-foreground" />
    {error ? <Text accessibilityRole="alert" className="text-sm text-destructive">{error}</Text> : null}
    <Pressable accessibilityRole="button" disabled={disabled} onPress={submit}
      className={`rounded-md bg-primary px-4 py-2 ${disabled ? 'opacity-50' : ''}`}>
      <Text className="text-center font-semibold text-primary-foreground">Sign in</Text>
    </Pressable>
  </View>;
}
