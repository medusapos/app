import { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Redirect, router, Stack } from 'expo-router';

import { ConnectorProvider } from '@tallyui/core';
import { medusaConnector } from '@tallyui/connector-medusa';

import { Catalogue } from '../components/catalogue';
import { variantPriceLabel, type CatalogueEntry } from '../lib/catalogue';
import { storeConfig } from '../lib/config';
import type { Session } from '../lib/session';
import { useSession } from '../lib/session-context';
import { useReplicatedProducts, type SyncState } from '../lib/use-replicated-products';

const connector = medusaConnector;
const traitContext = { currency: storeConfig.currency };
const traits = connector.traits.product;

const STATE_LABEL: Record<SyncState, string> = {
  connecting: 'Connecting',
  syncing: 'Syncing',
  synced: 'Up to date',
  error: 'Sync error',
  offline: 'Offline · cached catalogue',
};

/**
 * Product lookup: every product replicated from the store, searchable by
 * name, SKU or barcode. The screen only composes TallyUI pieces; swapping
 * `connector` for another backend's connector is the only backend-specific
 * line.
 */
export default function ProductsScreen() {
  const { session, signOut, reportUnauthorized } = useSession();
  if (!session) return <Redirect href="/login" />;
  return <SignedInProducts session={session} signOut={signOut} onUnauthorized={reportUnauthorized} />;
}

function SignedInProducts({ session, signOut, onUnauthorized }: { session: Session; signOut: () => void; onUnauthorized: () => void }) {
  const credentials = useMemo(() => ({ api_token: session.token }), [session.token]);
  const { products, state, error } = useReplicatedProducts(connector, credentials, session.baseUrl, onUnauthorized);
  const [selected, setSelected] = useState<CatalogueEntry<any> | null>(null);

  const sorted = useMemo(
    () => products.filter(traits.isSellable).sort((a, b) => traits.getName(a).localeCompare(traits.getName(b))),
    [products],
  );
  const sellableCount = sorted.length;
  const statusText = `${connector.name} · ${STATE_LABEL[state]} · ${sellableCount.toLocaleString()} products`
    + (error ? ` · ${error}` : '');

  return (
    <ConnectorProvider connector={connector} traitContext={traitContext}>
      <Stack.Screen options={{ title: 'Products', headerRight: () => (
        <Pressable accessibilityRole="button" onPress={() => { signOut(); router.replace('/login'); }}>
          <Text className="text-foreground">Sign out</Text>
        </Pressable>
      ) }} />
      <View className="flex-1 bg-bg">
        <Catalogue products={sorted} traits={traits} currency={storeConfig.currency}
          onSelect={setSelected} statusText={statusText} />
        {selected ? (
          <View className="border-t border-border bg-card p-4">
            <Text className="text-foreground">
              Selected: {traits.getName(selected.product)} · {selected.variant.title} · {variantPriceLabel(selected.variant, storeConfig.currency)}
            </Text>
          </View>
        ) : null}
      </View>
    </ConnectorProvider>
  );
}
