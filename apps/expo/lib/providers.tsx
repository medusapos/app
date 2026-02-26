import type { ReactNode } from 'react';
import { View, Text, ActivityIndicator } from 'react-native';
import { ConnectorProvider } from '@tallyui/core';
import { CurrencyProvider, TaxProvider } from '@tallyui/pos';
import { medusaConnector } from '@tallyui/connector-medusa';
import { useDatabase, DatabaseProvider } from './hooks/use-database';
import { OrderBuilderProvider } from './hooks/use-order-builder';
import { CompletedOrdersProvider } from './hooks/use-completed-orders';

function LoadingScreen() {
  return (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
      <ActivityIndicator size="large" />
      <Text style={{ marginTop: 16, color: '#666' }}>Loading...</Text>
    </View>
  );
}

function ErrorScreen({ error }: { error: Error }) {
  return (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 }}>
      <Text style={{ color: '#dc2626', fontSize: 16, fontWeight: 'bold' }}>Error</Text>
      <Text style={{ color: '#666', marginTop: 8, textAlign: 'center' }}>{error.message}</Text>
    </View>
  );
}

export function AppProviders({ children }: { children: ReactNode }) {
  const { db, isLoading, error } = useDatabase();

  if (isLoading) return <LoadingScreen />;
  if (error) return <ErrorScreen error={error} />;

  return (
    <ConnectorProvider connector={medusaConnector}>
      <CurrencyProvider currencyCode="USD">
        <TaxProvider rates={{ default: 0.1 }} pricesIncludeTax={false}>
          <DatabaseProvider db={db!}>
            <OrderBuilderProvider>
              <CompletedOrdersProvider>
                {children}
              </CompletedOrdersProvider>
            </OrderBuilderProvider>
          </DatabaseProvider>
        </TaxProvider>
      </CurrencyProvider>
    </ConnectorProvider>
  );
}
