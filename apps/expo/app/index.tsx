import { useDeferredValue, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Text, View } from 'react-native';
import { Stack } from 'expo-router';

import { ConnectorProvider } from '@tallyui/core';
import {
  ProductImage,
  ProductPrice,
  ProductSku,
  ProductStockBadge,
  ProductTitle,
  SearchInput,
} from '@tallyui/components';
import { medusaConnector } from '@tallyui/connector-medusa';
import { searchProducts } from '@tallyui/pos';

import { storeConfig } from '../lib/config';
import { useReplicatedProducts, type SyncState } from '../lib/use-replicated-products';

const connector = medusaConnector;
const credentials = { api_token: storeConfig.apiKey };
const traitContext = { currency: storeConfig.currency };
const traits = connector.traits.product;

const STATE_LABEL: Record<SyncState, string> = {
  connecting: 'Connecting',
  syncing: 'Syncing',
  synced: 'Up to date',
  error: 'Sync error',
};

/**
 * Product lookup: every product replicated from the store, searchable by
 * name, SKU or barcode. The screen only composes TallyUI pieces; swapping
 * `connector` for another backend's connector is the only backend-specific
 * line.
 */
export default function ProductsScreen() {
  const { products, state, error } = useReplicatedProducts(connector, credentials, storeConfig.baseUrl);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);

  const sorted = useMemo(
    () => products.filter(traits.isSellable).sort((a, b) => traits.getName(a).localeCompare(traits.getName(b))),
    [products],
  );
  const sellableCount = sorted.length;
  const results = useMemo(
    () => searchProducts(sorted, deferredQuery, traits),
    [sorted, deferredQuery],
  );

  return (
    <ConnectorProvider connector={connector} traitContext={traitContext}>
      <Stack.Screen options={{ title: 'Products' }} />
      <View className="flex-1 bg-bg">
        <View className="gap-2 border-b border-border bg-card px-4 pb-3 pt-3">
          <SearchInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search name, SKU or barcode"
            autoFocus
          />
          <View className="flex-row items-center gap-2">
            {state === 'syncing' || state === 'connecting' ? (
              <ActivityIndicator size="small" />
            ) : null}
            <Text className={state === 'error' ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
              {connector.name} · {STATE_LABEL[state]} · {sellableCount.toLocaleString()} products
              {deferredQuery.trim() ? ` · ${results.length.toLocaleString()} matching` : ''}
              {error ? ` · ${error}` : ''}
            </Text>
          </View>
        </View>

        <FlatList
          data={results}
          keyExtractor={(item) => traits.getId(item)}
          initialNumToRender={20}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => (
            <View className="flex-row items-center gap-3 border-b border-border bg-card px-4 py-2.5">
              <ProductImage doc={item} size={48} showPlaceholder className="rounded-md" />
              <View className="flex-1 gap-0.5">
                <ProductTitle doc={item} className="text-[15px] font-semibold" numberOfLines={1} />
                <ProductSku doc={item} />
              </View>
              <View className="items-end gap-1">
                <ProductPrice doc={item} className="text-[15px]" />
                <ProductStockBadge doc={item} showQuantity />
              </View>
            </View>
          )}
          ListEmptyComponent={
            state === 'synced' ? (
              <Text className="mt-10 text-center text-sm text-muted-foreground">
                {deferredQuery.trim() ? `No products match "${deferredQuery.trim()}".` : 'No products yet.'}
              </Text>
            ) : null
          }
        />
      </View>
    </ConnectorProvider>
  );
}
