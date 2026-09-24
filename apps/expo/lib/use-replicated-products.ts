import { useEffect, useRef, useState } from 'react';

import { createTallyDatabase, startReplication } from '@tallyui/database';
import type { SyncContext, TallyConnector } from '@tallyui/core';
import { isUnauthorizedError, productCacheName, productCacheStorage, registerOpenCache } from './product-cache';

export type SyncState = 'connecting' | 'syncing' | 'synced' | 'error' | 'offline';

export function classifyReplicationError(err: unknown): 'unauthorized' | 'http' | 'offline' {
  if (isUnauthorizedError(err)) return 'unauthorized';
  const error = err as { message?: unknown; parameters?: { errors?: { message?: unknown }[] } } | null;
  const message = error?.parameters?.errors?.[0]?.message ?? error?.message;
  return typeof message === 'string' && /^Medusa API error: \d+$/.test(message) ? 'http' : 'offline';
}

/**
 * Replicates a connector's products into a local RxDB database and keeps a
 * live list of them. Nothing here is backend-specific: the connector
 * supplies the schema and pull handler; the caller supplies auth headers.
 */
export function useReplicatedProducts(
  connector: TallyConnector,
  headers: Record<string, string>,
  baseUrl: string,
  onUnauthorized: () => void,
) {
  const [products, setProducts] = useState<any[]>([]);
  const [state, setState] = useState<SyncState>('connecting');
  const [error, setError] = useState<string | null>(null);
  const debug = useRef<{
    lastProductsEmission: string | null; lastReplicationError: string | null;
    replication?: ReturnType<typeof startReplication>;
  }>({ lastProductsEmission: null, lastReplicationError: null });

  useEffect(() => {
    if (process.env.EXPO_PUBLIC_E2E_DEBUG !== '1' || typeof window === 'undefined') return;
    if (error !== null) debug.current.lastReplicationError = error;
    const traits = connector.traits.product;
    const sellable = products.filter(traits.isSellable);
    (window as Window & { __medusaposCatalogue?: unknown }).__medusaposCatalogue = {
      state, replicatedProductCount: products.length, sellableProductCount: sellable.length,
      sellableSkus: sellable.flatMap((product) => traits.getVariants!(product).map((variant) => variant.sku)),
      nonSellableSkus: products.filter((product) => !traits.isSellable(product))
        .flatMap((product) => traits.getVariants!(product).map((variant) => variant.sku)),
      lastProductsEmission: debug.current.lastProductsEmission,
      lastReplicationError: debug.current.lastReplicationError,
      get checkpoint() { try { return debug.current.replication?.internalReplicationState?.lastCheckpointDoc?.down?.checkpointData; } catch { return undefined; } },
    };
  }, [connector, products, state, error]);

  useEffect(() => {
    const adapter = connector.replication?.products;
    if (!adapter) {
      setState('error');
      setError(`${connector.name} has no product replication adapter.`);
      return;
    }

    let cancelled = false;
    let unauthorizedReported = false;
    const cleanup: Array<() => unknown> = [];

    (async () => {
      try {
        const name = productCacheName(connector.id, baseUrl);
        const db = await createTallyDatabase({ connector, name, storage: productCacheStorage() });
        cleanup.push(registerOpenCache(name, db));
        cleanup.push(() => db.close());
        const context: SyncContext = {
          connectorId: connector.id,
          baseUrl,
          // The caller passes the connector's auth headers.
          headers,
        };

        const subscription = db.products.find().$.subscribe((docs) => {
          if (!cancelled) {
            if (process.env.EXPO_PUBLIC_E2E_DEBUG === '1') debug.current.lastProductsEmission = new Date().toISOString();
            setProducts(docs.map((doc) => doc.toJSON()));
          }
        });
        cleanup.unshift(() => subscription.unsubscribe());

        const replication = startReplication({ collection: db.products, adapter, context });
        if (process.env.EXPO_PUBLIC_E2E_DEBUG === '1') debug.current.replication = replication;
        cleanup.unshift(() => replication.cancel());
        replication.error$.subscribe((err) => {
          if (cancelled) return;
          const classification = classifyReplicationError(err);
          setState(classification === 'offline' ? 'offline' : 'error');
          setError(String(err?.parameters?.errors?.[0]?.message ?? err?.message ?? err));
          if (!unauthorizedReported && classification === 'unauthorized') {
            unauthorizedReported = true;
            onUnauthorized();
          }
        });

        let wasActive = false;
        const activity = replication.active$.subscribe((active) => {
          // RxDB stays active during pull retries; idle after activity means the pull completed.
          if (!cancelled && wasActive && !active) {
            setState('synced');
            setError(null);
          }
          wasActive = active;
        });
        cleanup.unshift(() => activity.unsubscribe());

        setState('syncing');
        await replication.awaitInitialReplication();
        if (!cancelled) {
          setState('synced');
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setState('error');
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();

    return () => {
      cancelled = true;
      for (const fn of cleanup) fn();
    };
  }, [connector, baseUrl, headers, onUnauthorized]);

  return { products, state, error };
}
