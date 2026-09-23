import { useEffect, useState } from 'react';

import { createTallyDatabase, startReplication } from '@tallyui/database';
import type { SyncContext, TallyConnector } from '@tallyui/core';

export type SyncState = 'connecting' | 'syncing' | 'synced' | 'error';

/**
 * Replicates a connector's products into a local RxDB database and keeps a
 * live list of them. Nothing here is backend-specific: the connector
 * supplies the schema, auth headers and pull handler.
 */
export function useReplicatedProducts(
  connector: TallyConnector,
  credentials: Record<string, string>,
  baseUrl: string,
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
    let failed = false;
    const cleanup: Array<() => unknown> = [];

    (async () => {
      try {
        const db = await createTallyDatabase({ connector, name: `medusapos_${connector.id}` });
        cleanup.push(() => db.close());
        const context: SyncContext = {
          connectorId: connector.id,
          baseUrl,
          headers: connector.auth.getHeaders(credentials),
        };

        const subscription = db.products.find().$.subscribe((docs) => {
          if (!cancelled) setProducts(docs.map((doc) => doc.toJSON()));
        });
        cleanup.unshift(() => subscription.unsubscribe());

        const replication = startReplication({ collection: db.products, adapter, context });
        cleanup.unshift(() => replication.cancel());
        replication.error$.subscribe((err) => {
          if (cancelled) return;
          failed = true;
          setState('error');
          setError(String(err?.parameters?.errors?.[0]?.message ?? err?.message ?? err));
        });

        setState('syncing');
        await replication.awaitInitialReplication();
        if (!cancelled && !failed) setState('synced');
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
  }, [connector, baseUrl, credentials]);

  return { products, state, error };
}
