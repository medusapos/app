import { createTallyDatabase, getStorage } from '@tallyui/database';
import type { TallyDatabase } from '@tallyui/database';
import { medusaConnector } from '@tallyui/connector-medusa';
import { SAMPLE_PRODUCTS } from './sample-data';

let dbPromise: Promise<TallyDatabase> | null = null;

export function getDatabase(): Promise<TallyDatabase> {
  if (!dbPromise) {
    dbPromise = initDatabase();
  }
  return dbPromise;
}

async function initDatabase(): Promise<TallyDatabase> {
  const db = await createTallyDatabase({
    connector: medusaConnector,
    storage: getStorage(),
  });

  // Seed with sample data if empty
  const existing = await db.collections.products.find().exec();
  if (existing.length === 0) {
    await db.collections.products.bulkInsert(SAMPLE_PRODUCTS);
  }

  return db;
}

export type { TallyDatabase };
