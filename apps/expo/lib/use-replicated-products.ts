import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { createTallyDatabase, startReplication, startStockReconcile, STOCK_LEVELS_COLLECTION } from '@tallyui/database';
import type { SyncContext, TallyConnector } from '@tallyui/core';
import { stockOverlay$ } from '@tallyui/pos';
import { isUnauthorizedError, productCacheName, productCacheStorage, registerOpenCache } from './product-cache';

/** How often the app checks stock against the store (ADR-060). */
export const STOCK_CHECK_INTERVAL_MS = 5 * 60_000;
// The app drives the cadence so it can record each completed pass, so the runner's own timer is
// parked at the longest delay setInterval accepts (longer ones overflow and fire at once).
// Interim: once TallyUI's runner exposes its pass state (state$ with lastCompletedAt), use the
// runner's interval and read that instead.
const RUNNER_INTERVAL_MS = 2 ** 31 - 1;

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
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stockOverlay, setStockOverlay] = useState<Map<string, unknown>>();
  const [lastStockCheckAt, setLastStockCheckAt] = useState<Date | null>(null);
  const stockRunner = useRef<ReturnType<typeof startStockReconcile>>(undefined);
  const reconcileStock = useCallback(async () => {
    const runner = stockRunner.current;
    if (!runner) return;
    try {
      // The runner itself warns about a truncated pass.
      const result = await runner.reconcileStock();
      if (!result.truncated && stockRunner.current === runner) setLastStockCheckAt(new Date());
    } catch (err) {
      // A pass aborted by stop() on unmount is not a failure.
      if (stockRunner.current === runner) console.warn('Stock reconcile failed:', err);
    }
  }, []);
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
        // Unmounted while opening: cleanup has already run, so start nothing that would outlive it.
        if (cancelled) {
          await db.close();
          return;
        }
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
            setLastSyncedAt(new Date());
            setError(null);
          }
          wasActive = active;
        });
        cleanup.unshift(() => activity.unsubscribe());

        const stockAdapter = connector.reconcile?.stock;
        if (stockAdapter) {
          const collection = db[STOCK_LEVELS_COLLECTION];
          const runner = startStockReconcile({ collection, adapter: stockAdapter, context, intervalMs: RUNNER_INTERVAL_MS });
          stockRunner.current = runner;
          const overlay = stockOverlay$(collection).subscribe((map) => { if (!cancelled) setStockOverlay(map); });
          const timer = setInterval(reconcileStock, STOCK_CHECK_INTERVAL_MS);
          // On web, react-native-web's AppState follows page visibility.
          const foreground = AppState.addEventListener('change', (next) => { if (next === 'active') void reconcileStock(); });
          cleanup.unshift(() => {
            stockRunner.current = undefined;
            runner.stop();
            overlay.unsubscribe();
            clearInterval(timer);
            foreground.remove();
          });
        }

        setState('syncing');
        await replication.awaitInitialReplication();
        if (!cancelled) {
          setState('synced');
          setLastSyncedAt(new Date());
          setError(null);
          void reconcileStock();
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
  }, [connector, baseUrl, headers, onUnauthorized, reconcileStock]);

  return { products, state, error, lastSyncedAt, stockOverlay, lastStockCheckAt, reconcileStock };
}
