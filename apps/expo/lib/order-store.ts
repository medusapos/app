import { createRxDatabase, type RxCollection } from 'rxdb';
import { wrappedValidateAjvStorage } from 'rxdb/plugins/validate-ajv';
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
      const db = await createRxDatabase<{ pos_orders: RxCollection<PosOrder> }>({
        name, multiInstance: false,
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
      // closeOrderStores() may already be closing this same entry; share that
      // promise instead of closing the database a second time.
      if (!shared.closing) {
        shared.closing = store.close().then(() => {
          // A store opened for this name after closeOrderStores() ran is a
          // different entry: never delete it under a late close() like this one.
          if (stores.get(name) === shared) stores.delete(name);
        });
      }
      await shared.closing;
    }
  } };
}

/**
 * Closes every open or still-opening store and removes it, so the next
 * `openOrderStore` for that name opens a fresh database. A store still
 * opening is closed once its open settles; a failed open counts as closed
 * (it already closed its own database). A later `close()` from a handle
 * handed out before this ran shares the same close and never touches a
 * store opened for that name afterwards.
 */
export async function closeOrderStores(): Promise<void> {
  await Promise.all([...stores.entries()].map(async ([name, entry]) => {
    if (!entry.closing) {
      entry.closing = entry.opening.then((store) => store.close(), () => undefined);
    }
    await entry.closing;
    if (stores.get(name) === entry) stores.delete(name);
  }));
}

export function needsAttention(orders: PosOrder[]): PosOrder[] {
  return orders.filter((order) => order.syncStatus === 'rejected'
    || (order.syncStatus === 'applied' && !!order.warnings?.length))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
