import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { adminToken, captureSales, ordersByClientId, sellBySku, signIn, stockBySku, variantIdBySku } from './helpers';

const backend = process.env.E2E_BACKEND_URL ?? 'http://localhost:9100';

// Builds one pending PosOrder for a single E2E-1 (25% Danish VAT, tax-exclusive prices, matching
// dev/medusa-store's seed-e2e.ts region), by the same shape `@tallyui/pos`'s `finalizeOrder`
// produces (see apps/expo/lib/order-store.ts's carry-over and posOrderSchema). Built here as a
// plain literal rather than imported from `@tallyui/pos`, which this file (Node, not Metro/Vitest)
// has no source-resolution alias for.
function pendingE2E1Order(variantId: string) {
  const unitPriceMinor = 200; // E2E product 1's seeded price: EUR 2.00
  const taxMinor = 50; // 25% of 200
  const now = new Date().toISOString();
  const orderId = randomUUID();
  return {
    id: orderId, createdAt: now, updatedAt: now, commandId: randomUUID(), syncStatus: 'pending' as const,
    currency: 'EUR', pricesIncludeTax: false,
    lines: [{
      id: randomUUID(), productId: 'e2e-1', variantId, name: 'E2E product 1', sku: 'E2E-1',
      quantity: 1, unitPriceMinor, discountMinor: 0, netMinor: unitPriceMinor,
      taxLines: [{ code: 'DK25', ratePpm: 250_000, taxMicros: String(unitPriceMinor * 250_000) }],
    }],
    payments: [{ id: randomUUID(), method: 'cash' as const, amountMinor: unitPriceMinor + taxMinor,
      tenderedMinor: unitPriceMinor + taxMinor, changeMinor: 0 }],
    subtotalMinor: unitPriceMinor, discountMinor: 0, taxMinor, totalMinor: unitPriceMinor + taxMinor,
    customer: null,
  };
}

test('cold open, offline sale, and reload keep the SQLite catalogue and carry the sale forward', async ({ page }) => {
  const token = await adminToken();
  const before = await stockBySku(token);
  const sales = captureSales(page);

  await signIn(page); // cold: "Up to date · 5 products", replicated fresh into the SQLite-wasm cache.

  await page.route('**/tally/v1/commands', (route) => route.abort());
  await sellBySku(page, ['E2E-1'], 'exact'); // stays on the products screen; the sale stays pending.

  await page.route('**/admin/products**', (route) => route.abort());
  await page.reload(); // still the products route: the reload lands back on the catalogue.

  // The catalogue count comes straight from the SQLite-wasm cache: the product pull is blocked.
  await expect(page.getByText(/5 products/)).toBeVisible();
  await page.getByRole('button', { name: /^Orders(?: \(\d+\))?$/ }).click();
  // Matched narrowly (leading " · "): the order row's own text, not the "Sync status" banner,
  // which also (lowercase, case-insensitively the same) contains "waiting to sync".
  await expect(page.getByText('· Waiting to sync', { exact: false })).toBeVisible();

  await page.unroute('**/tally/v1/commands');
  await page.unroute('**/admin/products**');
  await expect(page.getByText('· Synced', { exact: false })).toBeVisible({ timeout: 30_000 });

  expect(sales.size).toBe(1);
  const [clientId] = sales.keys();
  const orders = (await ordersByClientId(token)).filter((order) => order.metadata.tally_client_id === clientId);
  expect(orders).toHaveLength(1);

  const after = await stockBySku(token);
  expect(after['E2E-1']).toBe(before['E2E-1'] - 1);
});

test('a pending order left in the legacy Dexie store carries over on sign-in and syncs', async ({ page }) => {
  const token = await adminToken();
  const before = await stockBySku(token);
  const variantId = await variantIdBySku(token, 'E2E-1');
  const sales = captureSales(page);
  const order = pendingE2E1Order(variantId);

  await page.goto('/login');
  await page.waitForLoadState('networkidle');
  await page.evaluate(([backendUrl, posOrder]) => (window as unknown as {
    __medusaposSeedLegacyOrder: (base: string, order: unknown) => Promise<void>;
  }).__medusaposSeedLegacyOrder(backendUrl, posOrder), [backend, order] as const);

  await signIn(page);
  await page.getByRole('button', { name: /^Orders(?: \(\d+\))?$/ }).click();
  await expect(page.getByText('· Synced', { exact: false })).toBeVisible({ timeout: 30_000 });

  expect(sales.has(order.id)).toBe(true);
  const orders = (await ordersByClientId(token)).filter((o) => o.metadata.tally_client_id === order.id);
  expect(orders).toHaveLength(1);

  // The legacy Dexie order database (pre-SQLite prefix `medusapos_orders_`) is gone: carried
  // over, verified, marked, then removed (apps/expo/lib/order-store.ts's carryOverOrders).
  const legacyDatabases = await page.evaluate(async () => {
    const databases = await indexedDB.databases();
    return databases.map((db) => db.name).filter((name) => name?.startsWith('rxdb-dexie-medusapos_orders_'));
  });
  expect(legacyDatabases).toEqual([]);

  const after = await stockBySku(token);
  expect(after['E2E-1']).toBe(before['E2E-1'] - 1);
});
