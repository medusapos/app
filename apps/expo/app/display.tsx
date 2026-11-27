import { useEffect, useState } from 'react';
import { Platform, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { Button, CustomerDisplayPairing, Input, Text } from '@tallyui/components';
import { medusaDisplaySignalling } from '@tallyui/connector-medusa';
import { DEFAULT_ICE_SERVERS } from '@tallyui/core';
import { createDisplayClient, useDisplayClient, type DisplayClient } from '@tallyui/pos';
import { storeConfig } from '../lib/config';
import { clearDisplayStore, displayTokenStore, loadDisplayStore, saveDisplayStore } from '../lib/customer-display';
import { defaultStorage, LoginError, normalizeBaseUrl } from '../lib/session';

function PairDisplay({ baseUrl, onChangeStore }: { baseUrl: string; onChangeStore: () => void }) {
  const [client, setClient] = useState<DisplayClient | null>(null);
  useEffect(() => {
    const next = createDisplayClient({ signalling: medusaDisplaySignalling, context: { baseUrl },
      tokens: displayTokenStore(defaultStorage(), baseUrl), advertisement: { iceServers: [...DEFAULT_ICE_SERVERS], snapshot: true } });
    setClient(next);
    return () => next.close();
  }, [baseUrl]);
  const view = useDisplayClient(client);
  async function changeStore() {
    client?.close();
    const storage = defaultStorage();
    await displayTokenStore(storage, baseUrl).clear();
    clearDisplayStore(storage);
    onChangeStore();
  }
  return <View className="flex-1 bg-background">
    {view.phase.phase !== 'paired' && <Text testID="display-store-host">Store: {new URL(baseUrl).host}</Text>}
    {client && <CustomerDisplayPairing client={view} onClaim={client.claim} onCancel={client.cancel} />}
    {view.phase.phase === 'enter-code' && <Button testID="display-change-store" onPress={changeStore}><Text>Change store</Text></Button>}
  </View>;
}

function WebDisplay() {
  const { store } = useLocalSearchParams<{ store?: string | string[] }>();
  const [baseUrl, setBaseUrl] = useState(() => loadDisplayStore(defaultStorage()));
  const [address, setAddress] = useState((Array.isArray(store) ? store[0] : store) ?? storeConfig.defaultBaseUrl);
  const [error, setError] = useState('');
  function connect() {
    try {
      const url = normalizeBaseUrl(address);
      saveDisplayStore(defaultStorage(), url);
      setError('');
      setBaseUrl(url);
    } catch (cause) {
      if (!(cause instanceof LoginError)) throw cause;
      setError(cause.message);
    }
  }
  if (baseUrl) return <PairDisplay baseUrl={baseUrl} onChangeStore={() => { setAddress(baseUrl); setBaseUrl(null); }} />;
  return <View className="flex-1 items-center justify-center bg-background p-6">
    <View className="w-full max-w-md gap-4">
      <Text accessibilityRole="header" className="text-xl font-semibold">Connect to a store</Text>
      <Text nativeID="store-address-label">Store address</Text>
      <Input><Input.Field testID="display-store-url" accessibilityLabelledBy="store-address-label" autoCapitalize="none"
        autoCorrect={false} value={address} onChangeText={setAddress} /></Input>
      {error !== '' && <Text testID="display-store-error" className="text-destructive">{error}</Text>}
      <Button testID="display-store-connect" onPress={connect}><Text>Connect</Text></Button>
    </View>
  </View>;
}

export default function DisplayRoute() {
  if (Platform.OS !== 'web') return <Text testID="display-web-only">The customer display runs in a web browser. Open this page in a browser on the display device.</Text>;
  return <WebDisplay />;
}
