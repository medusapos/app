import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { adminToken, captureSales, chooseRegion, ordersByClientId, sellBySku, signIn, stockBySku, variantIdBySku } from './helpers';
import { E2E_RUN } from './ports';

const backend = process.env.E2E_BACKEND_URL ?? `http://localhost:${E2E_RUN.backendPort}`;
const credentials = { email: process.env.E2E_EMAIL ?? 'e2e@tally.test', password: process.env.E2E_PASSWORD ?? 'e2e-password' };
const SEARCH_PLACEHOLDER = 'Search or scan barcode / SKU';

// Fills in and submits the sign-in form, like `signIn` (helpers.ts), but without that helper's
// own wait for "Up to date": a storage-start failure never reaches it, showing the blocked
// screen instead.
async function submitSignIn(page: Page) {
  await page.goto('/login');
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(async () => {
    await page.getByLabel('Backend URL', { exact: true }).clear();
    await page.getByLabel('Backend URL', { exact: true }).fill(backend);
    await page.getByLabel('Email', { exact: true }).fill(credentials.email);
    await page.getByLabel('Password', { exact: true }).fill(credentials.password);
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled({ timeout: 1000 });
  }).toPass({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

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

// TallyUI #123 (pos_orders schema v1): a pending sale the SQLite order store holds at schema v0,
// as a build from before the bump wrote it, survives the v1 build's open and syncs once.
test('a pending sale in the SQLite order store at schema v0 migrates on open, waits, then syncs once', async ({ page }) => {
  const token = await adminToken();
  const before = await stockBySku(token);
  const order = pendingE2E1Order(await variantIdBySku(token, 'E2E-1'));
  const sales = captureSales(page);

  await page.goto('/login');
  await page.waitForLoadState('networkidle');
  expect(await page.evaluate(([backendUrl, posOrder]) => (window as unknown as {
    __medusaposSeedV0Order: (base: string, order: unknown) => Promise<number>;
  }).__medusaposSeedV0Order(backendUrl, posOrder), [backend, order] as const)).toBe(0);

  // signIn loads /login afresh (a new page, as after a build switch); its store open migrates v0 to v1.
  await page.route('**/tally/v1/commands', (route) => route.abort());
  await signIn(page);
  await page.getByRole('button', { name: /^Orders(?: \(\d+\))?$/ }).click();
  await expect(page.getByText('· Waiting to sync', { exact: false })).toBeVisible();

  await page.unroute('**/tally/v1/commands');
  await expect(page.getByText('· Synced', { exact: false })).toBeVisible({ timeout: 30_000 });
  expect(sales.has(order.id)).toBe(true);
  const orders = (await ordersByClientId(token)).filter((o) => o.metadata.tally_client_id === order.id);
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
  // Written at schema v0, as by a build from before TallyUI #123: the carry-over's v1 open migrates it.
  expect(await page.evaluate(([backendUrl, posOrder]) => (window as unknown as {
    __medusaposSeedLegacyOrder: (base: string, order: unknown) => Promise<number>;
  }).__medusaposSeedLegacyOrder(backendUrl, posOrder), [backend, order] as const)).toBe(0);

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

// F1 in miniature: another tab still on the old build writes a legacy sale after this tab's
// first carry-over already wrote the marker. The next open must carry it over, not delete it.
test('a legacy sale written after the first carry-over is carried over on reload and syncs once', async ({ page }) => {
  const token = await adminToken();
  const variantId = await variantIdBySku(token, 'E2E-1');
  const sales = captureSales(page);
  const seedLegacy = (order: ReturnType<typeof pendingE2E1Order>) => page.evaluate(([backendUrl, posOrder]) => (window as unknown as {
    __medusaposSeedLegacyOrder: (base: string, order: unknown) => Promise<number>;
  }).__medusaposSeedLegacyOrder(backendUrl, posOrder), [backend, order] as const);
  const legacyDatabases = () => page.evaluate(async () => (await indexedDB.databases())
    .map((db) => db.name).filter((name) => name?.startsWith('rxdb-dexie-medusapos_orders_')));

  const first = pendingE2E1Order(variantId);
  await page.goto('/login');
  await page.waitForLoadState('networkidle');
  await seedLegacy(first);
  await signIn(page);
  await expect.poll(() => sales.has(first.id), { timeout: 30_000 }).toBe(true);
  await expect.poll(legacyDatabases).toEqual([]);

  // The old build's tab is its own JS realm: seed from a fresh page, since this one's Dexie
  // handles for the legacy name were closed when the carry-over deleted that database.
  await page.reload();
  await expect(page.getByText(/Up to date · 5 products/)).toBeVisible();
  const second = pendingE2E1Order(variantId);
  await seedLegacy(second);
  expect(await legacyDatabases()).not.toEqual([]);
  await page.reload();
  await page.getByRole('button', { name: /^Orders(?: \(\d+\))?$/ }).click();
  await expect(page.getByText('· Synced', { exact: false })).toHaveCount(2, { timeout: 30_000 });
  await expect(page.getByText('· Waiting to sync', { exact: false })).toHaveCount(0);

  expect(sales.has(second.id)).toBe(true);
  for (const order of [first, second]) {
    const matching = (await ordersByClientId(token)).filter((o) => o.metadata.tally_client_id === order.id);
    expect(matching).toHaveLength(1);
  }
  expect(await legacyDatabases()).toEqual([]);
});

test('a dead storage worker shows the reload prompt, and Reload recovers the app', async ({ page }) => {
  await signIn(page);

  // A rejected order first, with the real worker still alive: RxDB only re-reads storage for a
  // query it has not already cached an in-sync result for (rx-query.js's _isResultsInSync), so
  // reaching `dead` afterwards needs a genuinely new one. Orders screen's Retry (requeue's
  // `id: { $in: [...] }` selector) is exactly that, once the order below exists to retry. The
  // route answers every command as rejected without reaching the real backend (no phantom order,
  // no stock decrement, and no `route.fetch()` race with a second matching request).
  await page.route('**/tally/v1/commands', async (route) => {
    const { commands } = route.request().postDataJSON() as { commands: { id: string }[] };
    await route.fulfill({ json: { results: commands.map((command) => ({
      id: command.id, status: 'rejected',
      error: { code: 'e2e-storage-test', message: 'forced rejection for e2e' },
    })) } });
  });
  await sellBySku(page, ['E2E-1'], 'exact');
  await page.unroute('**/tally/v1/commands');

  await page.evaluate(() => (window as unknown as {
    __medusaposKillStorageWorker: () => void;
  }).__medusaposKillStorageWorker());

  // The write: a second, different sale saves to the same dead order store. It never completes;
  // only recovery is checked below.
  const search = page.getByPlaceholder(SEARCH_PLACEHOLDER, { exact: true });
  await search.fill('E2E-1');
  await search.press('Enter');
  await page.getByRole('button', { name: 'Cash', exact: true }).click();
  const tender = page.getByText('Cash Tendered', { exact: true }).locator('..');
  await tender.locator('[tabindex="0"]').first().click();
  await page.getByRole('button', { name: 'Complete sale', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Saving is slow…');

  // The read: Retry's requeue() query has never run before, so it must reach the (now dead)
  // storage, giving the read watchdog something pending to go quiet on. This is the only visit
  // to Orders after the kill: leaving Products unmounts its product cache, whose close() also
  // hangs, so a later return to Products would reopen the same database name before that close
  // ever finishes (RxDB DB8).
  await page.getByRole('button', { name: /^Orders(?: \(\d+\))?$/ }).click();
  await expect(page).toHaveURL(/\/orders/);
  const retryButton = page.getByRole('button', { name: 'Retry' });
  await expect(retryButton).toBeVisible();
  await retryButton.click();

  await expect(page.getByText('Storage stopped')).toBeVisible();
  await page.getByRole('button', { name: 'Reload' }).click();
  await expect(page.getByText('Up to date · 5 products')).toBeVisible();
});

test('the opfs-sahpool pool held by another worker blocks the app with Reload', async ({ page, context }) => {
  const holder = await context.newPage();
  // A same-origin static URL, so `new Worker(...)` below is same-origin too: any served static
  // file works, the worker script itself, next to the one under test.
  await holder.goto('/sqlite/tallyui-sqlite-worker.js');
  await holder.evaluate((workerUrl) => {
    (window as unknown as { __holderWorker: Worker }).__holderWorker =
      new Worker(workerUrl, { type: 'module' });
  }, '/sqlite/tallyui-sqlite-worker.js');
  // The worker installs the opfs-sahpool at start-up; there is no signal to wait on from here,
  // so a fixed wait covers it (this is a holder page, not the app under test).
  await holder.waitForTimeout(2000);

  await submitSignIn(page);
  await expect(page.getByText('MedusaPOS is open in another tab. Close that tab to use it here, or reload this one.')).toBeVisible();
  // LiveTabScreen's Pressable renders with no explicit accessibility role (live-tab.spec.ts).
  const reload = page.getByText('Reload', { exact: true });
  await expect(reload).toBeVisible();

  await holder.close();
  await reload.click();
  // A fresh till: the store has two regions, so it asks once (as `signIn` does).
  await chooseRegion(page, 'Europe');
  await expect(page.getByText('Up to date · 5 products')).toBeVisible();
});
