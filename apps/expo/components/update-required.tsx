import { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { Button, Text as ButtonText } from '@tallyui/components';

import { AppText as Text } from './app-text';
import { readPluginContract } from '../lib/plugin-contract';
import type { Session } from '../lib/session';

/**
 * WCPOS v2's upgrade-required latch: one read of /info per store; only a conclusive `too_old` latches, so offline
 * or a failed read leaves the till as it is. Check again clears the latch on `ok` and reports an inconclusive read.
 */
export function usePluginContract(session: Session) {
  const { baseUrl } = session;
  // A token refresh is not a new store: read the token through a ref so it never triggers a read.
  const token = useRef(session.token);
  token.current = session.token;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [latched, setLatched] = useState(false);
  const [checking, setChecking] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    void readPluginContract({ baseUrl, token: token.current }).then((status) => { if (active && status === 'too_old') setLatched(true); });
    return () => { active = false; };
  }, [baseUrl]);
  const checkAgain = useCallback(() => {
    setChecking(true);
    setFailed(false);
    void readPluginContract({ baseUrl, token: token.current }).then((status) => {
      if (!mounted.current) return;
      setChecking(false);
      if (status === 'ok') setLatched(false);
      else if (status === 'unknown') setFailed(true);
    });
  }, [baseUrl]);
  return { latched, checking, failed, checkAgain };
}

export function UpdateRequired(props: { baseUrl: string; checking: boolean; failed: boolean; onCheckAgain(): void; onSignOut(): void }) {
  const { baseUrl, checking, failed, onCheckAgain, onSignOut } = props;
  return <View testID="update-required-screen" dataSet={{ print: 'hide' }} className="flex-1 items-center justify-center gap-4 p-6">
    <View className="w-full max-w-md gap-4">
      <Text accessibilityRole="header" className="text-xl font-semibold text-foreground">Update required</Text>
      <Text className="text-foreground">This app needs a newer MedusaPOS plugin than the store at {baseUrl} is running.</Text>
      <Text className="text-foreground">Update @medusapos/medusa-plugin on the Medusa server and restart it, then check again.</Text>
      {failed ? <Text className="text-destructive">Could not reach the store. Try again in a moment.</Text> : null}
      <Button testID="update-required-check-again" className="min-h-11" disabled={checking} onPress={onCheckAgain}>
        <ButtonText>{checking ? 'Checking…' : 'Check again'}</ButtonText>
      </Button>
      <Button variant="outline" testID="update-required-sign-out" className="min-h-11" onPress={onSignOut}><ButtonText>Sign out</ButtonText></Button>
    </View>
  </View>;
}
