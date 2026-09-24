import { createRxDatabase, type RxCollection } from 'rxdb';
import { wrappedValidateAjvStorage } from 'rxdb/plugins/validate-ajv';
import { Platform } from 'react-native';
import { posOrderSchema, type PosOrder } from '@tallyui/pos';
import { productCacheName, productCacheStorage } from './product-cache';

type OrderStore = { orders: RxCollection<PosOrder>; close(): Promise<void> };
const stores = new Map<string, { opening: Promise<OrderStore>; users: number; closing?: Promise<void> }>();

export function orderDatabaseName(baseUrl: string): string {
  return productCacheName('orders', baseUrl);
}

export async function openOrderStore(baseUrl: string): Promise<OrderStore> {
  const name = orderDatabaseName(baseUrl);
  let entry = stores.get(name);
  if (entry?.closing) {
    await entry.closing;
    return openOrderStore(baseUrl);
  }
  if (!entry) {
    const opening = (async () => {
      const storage = productCacheStorage();
      // On web, several tabs share one database; the outbox needs multiInstance and
      // localDocuments to elect a leader and forward follower state (TallyUI #42).
      const multiInstance = Platform.OS === 'web';
      const db = await createRxDatabase<{ pos_orders: RxCollection<PosOrder> }>({
        name, multiInstance, localDocuments: multiInstance,
        storage: process.env.NODE_ENV !== 'production' ? wrappedValidateAjvStorage({ storage }) : storage,
      });
      try {
        await db.addCollections({ pos_orders: { schema: posOrderSchema } });
        return { orders: db.pos_orders, close: async () => { await db.close(); } };
      } catch (error) { await db.close(); throw error; }
    })();
    entry = { opening, users: 0 };
    stores.set(name, entry);
    void opening.catch(() => { stores.delete(name); });
  }
  const shared = entry;
  shared.users++;
  const store = await shared.opening;
  let closed = false;
  return { orders: store.orders, async close() {
    if (closed) return;
    closed = true;
    if (--shared.users === 0) {
      shared.closing = store.close().then(() => { stores.delete(name); });
      await shared.closing;
    }
  } };
}

export function needsAttention(orders: PosOrder[]): PosOrder[] {
  return orders.filter((order) => order.syncStatus === 'rejected'
    || (order.syncStatus === 'applied' && !!order.warnings?.length))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
