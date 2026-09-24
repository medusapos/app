import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Pressable, Text, TextInput, View, type ViewProps } from 'react-native';
import { useOutboxContext } from '../lib/outbox-context';
import { useSession } from '../lib/session-context';

export function SignInAgain({ header, onLayout }: { header?: { setOptions: (options: { headerTitle?: () => ReactNode }) => void }; onLayout?: ViewProps['onLayout'] }) {
  const { session, signIn } = useSession();
  const { state, flush } = useOutboxContext();
  const [password, setPassword] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [shouldFlush, setShouldFlush] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!shouldFlush) return;
    setShouldFlush(false);
    // Wait for the new session token to reach the outbox before sending.
    void flush();
  }, [shouldFlush, flush]);
  const strip = useMemo(() => <View dataSet={{ print: 'hide' }} className="flex-row items-center gap-1">
    <Text numberOfLines={1} className="shrink text-foreground">{state.pending} {state.pending === 1 ? 'sale' : 'sales'} saved, waiting to send ·</Text>
    <Pressable accessibilityRole="button" onPress={() => setExpanded(true)}>
      <Text className="font-semibold text-primary">Sign in</Text>
    </Pressable>
  </View>, [state.pending]);
  useEffect(() => {
    if (!header) return;
    header.setOptions({ headerTitle: session && state.authRequired && !expanded ? () => strip : undefined });
    return () => header.setOptions({ headerTitle: undefined });
  }, [header, session, state.authRequired, expanded, strip]);
  if (!session || !state.authRequired || (header && !expanded)) return null;
  const disabled = signingIn || !password;

  async function submit() {
    if (!session || disabled) return;
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

  return <View onLayout={onLayout} dataSet={{ print: 'hide' }} style={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 1 }}
    className="gap-2 border-b border-border bg-card px-4 py-3">
    {!expanded ? strip : <>
    <Text accessibilityRole="header" className="font-semibold text-foreground">Sign in again</Text>
    <Text className="text-foreground">Your sign-in has expired, so {state.pending === 1 ? '1 sale is' : `${state.pending} sales are`} waiting to be sent. Enter the password for {session.email} to send them.</Text>
    <Text className="text-foreground">Password</Text>
    <TextInput accessibilityLabel="Password" value={password} onChangeText={setPassword}
      secureTextEntry autoCapitalize="none" autoCorrect={false} onSubmitEditing={submit}
      className="rounded-md border border-border px-3 py-2 text-foreground" />
    {error ? <Text accessibilityRole="alert" className="text-sm text-destructive">{error}</Text> : null}
    <Pressable accessibilityRole="button" disabled={disabled} onPress={submit}
      className={`rounded-md bg-primary px-4 py-2 ${disabled ? 'opacity-50' : ''}`}>
      <Text className="text-center font-semibold text-primary-foreground">Sign in</Text>
    </Pressable>
    <Pressable accessibilityRole="button" onPress={() => setExpanded(false)}>
      <Text className="text-center text-primary">Later</Text>
    </Pressable>
    </>}
  </View>;
}
