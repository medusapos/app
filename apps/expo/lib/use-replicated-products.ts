import { useEffect, useState } from 'react';

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
          // Connector credentials use Basic for secret API keys; a signed-in user's JWT needs Bearer.
          headers,
        };

        const subscription = db.products.find().$.subscribe((docs) => {
          if (!cancelled) setProducts(docs.map((doc) => doc.toJSON()));
        });
        cleanup.unshift(() => subscription.unsubscribe());

        const replication = startReplication({ collection: db.products, adapter, context });
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
