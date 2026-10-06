import { getAllCollectionDocuments, RXDB_VERSION, type RxCollection } from 'rxdb';
import { readRegister } from '@tallyui/pos';
// Copied into the released checkout; import only what every released order-store.ts exports.
import { openOrderStore, registerCollections } from './order-store';
import { exposeE2eHook } from './e2e-debug';

export type AppStoreDump = {
  rxdbVersion: string;
  stored: { name: string; version: number }[];
  docs: { pos_orders: object[]; register_sessions: object[]; cash_movements: object[]; closures: object[]; drafts: object[] };
  register: object | null;
};

/** Read-only snapshot for #128's carry-over test, used by both the released and next builds. */
export async function dumpAppStore(baseUrl: string): Promise<AppStoreDump> {
  const store = await openOrderStore(baseUrl);
  try {
    const { sessions, movements, closures } = registerCollections(store.orders);
    const drafts = store.orders.database.collections.drafts as RxCollection | undefined;
    const collections: Record<keyof AppStoreDump['docs'], RxCollection | undefined> = {
      pos_orders: store.orders, register_sessions: sessions, cash_movements: movements, closures, drafts,
    };
    const docs: AppStoreDump['docs'] = { pos_orders: [], register_sessions: [], cash_movements: [], closures: [], drafts: [] };
    for (const name of Object.keys(collections) as (keyof AppStoreDump['docs'])[]) {
      const collection = collections[name];
      if (!collection) continue;
      docs[name] = (await collection.find().exec())
        .sort((a, b) => a.primary.localeCompare(b.primary)).map((doc) => doc.toJSON());
    }
    const stored = (await getAllCollectionDocuments(store.orders.database.internalStore))
      .map(({ data }) => ({ name: data.name, version: data.schema.version }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.version - b.version);
    return { rxdbVersion: RXDB_VERSION, stored, docs, register: await readRegister(sessions) };
  } finally { await store.close(); }
}

if (process.env.EXPO_PUBLIC_E2E_DEBUG === '1' && typeof window !== 'undefined') {
  exposeE2eHook('DumpAppStore', dumpAppStore);
}
