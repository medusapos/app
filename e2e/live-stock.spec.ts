import { expect, test, type Page } from '@playwright/test';
import { adminToken, inventoryLevel, sellBySku, setInventoryLevel, signIn, variantIdBySku } from './helpers';

const PRODUCT_4 = 'E2E product 4';
// Single-variant, so the product-level status the tile badge shows is that one variant's own
// status — unlike E2E product 4, whose Default variant staying in stock would mask a change to
// just E2E-4B in the tile's (product-level) aggregate.
const PRODUCT_1 = 'E2E product 1';

// The variant chooser only opens for a product with more than one variant (E2E product 4 is the
// only such fixture product), and is the app's only stock display.
async function openChooser(page: Page) {
  await page.getByText(PRODUCT_4, { exact: true }).click();
}

function variantChoice(page: Page) {
  return page.getByRole('button', { name: /E2E-4B/ });
}

function stockStatusText(choice: ReturnType<typeof variantChoice>) {
  return choice.getByText(/^(In Stock|Out of Stock|On Backorder|Unknown) · /);
}

// The tile badge (apps/expo/components/catalogue.tsx) shows the status only, no quantity or "as
// of" (it has showAsOf={false}), unlike the chooser's "Status · as of …".
function tileBadgeText(page: Page, productName: string) {
  return page.getByTestId(`product-tile-${productName}`).getByText(/^(In Stock|Out of Stock|On Backorder|Unknown)$/);
}

// Formats are locale-dependent ("as of 14:32" or "as of 2:32 PM"); compare by minute of day so
// the assertion works regardless of the host's 12/24-hour preference.
function asOfMinutes(text: string): number {
  const match = text.match(/as of (\d{1,2}):(\d{2})(?:\s*([AaPp][Mm]))?/);
  if (!match) throw new Error(`No "as of" time found in: ${text}`);
  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const meridiem = match[3]?.toLowerCase();
  if (meridiem === 'am' && hours === 12) hours = 0;
  if (meridiem === 'pm' && hours !== 12) hours += 12;
  return hours * 60 + minutes;
}

// The app's AppState on web follows document.visibilityState (react-native-web); overriding the
// property and dispatching visibilitychange reproduces a real background/foreground cycle, which
// is what the stock-reconcile runner listens for.
async function triggerReconcile(page: Page) {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

test('stock change reaches the chooser without a catalogue pull', async ({ page }) => {
  const token = await adminToken();
  const { inventoryItemId, locationId, stockedQuantity: original } = await inventoryLevel(token, 'E2E-4B');
  const product1 = await inventoryLevel(token, 'E2E-1');
  try {
    await signIn(page);
    await openChooser(page);
    const before = await stockStatusText(variantChoice(page)).textContent();
    if (!before) throw new Error('No stock status text found for E2E-4B');
    const beforeMinutes = asOfMinutes(before);
    await expect(tileBadgeText(page, PRODUCT_1)).toHaveText('In Stock');

    // Flip the status server-side (0 reads Out of Stock), then reconcile without any catalogue
    // pull (no reload, no new sign-in). E2E-1 flips alongside E2E-4B so the same pass proves the
    // tile badge picks up reconciled stock too.
    await setInventoryLevel(token, inventoryItemId, locationId, 0);
    await setInventoryLevel(token, product1.inventoryItemId, product1.locationId, 0);
    await triggerReconcile(page);
    // The single-variant product's tile badge (its own product-level status, not the chooser)
    // reflects the pass; the chooser renders from the same pass.
    await expect(tileBadgeText(page, PRODUCT_1)).toHaveText('Out of Stock');

    let after = '';
    await expect(async () => {
      // The chooser is live (ADR 0007): it derives its choices from the current catalogue
      // entries, never a copy taken when it was opened. Re-opening it is a normal cashier action.
      // The short inner timeout lets toPass really retry.
      await openChooser(page);
      const status = stockStatusText(variantChoice(page));
      await expect(status).toHaveText(/^Out of Stock · /, { timeout: 1_000 });
      after = (await status.textContent()) ?? '';
    }).toPass({ timeout: 30_000 });

    expect(after).not.toBe(before);
    expect(asOfMinutes(after)).toBeGreaterThanOrEqual(beforeMinutes);
  } finally {
    await setInventoryLevel(token, inventoryItemId, locationId, original);
    await setInventoryLevel(token, product1.inventoryItemId, product1.locationId, product1.stockedQuantity);
  }
});

// ADR 0007 regression: the reconcile's inventory read is held back 750 ms and the chooser is opened
// before the pass lands and never re-opened. Only a live chooser shows the pass; a copy taken at
// open would keep "In Stock".
test('an open chooser shows a reconcile pass that lands after it opened', async ({ page }) => {
  const token = await adminToken();
  const { inventoryItemId, locationId, stockedQuantity: original } = await inventoryLevel(token, 'E2E-4B');
  let delayed = 0;
  try {
    await signIn(page);
    await openChooser(page);
    const status = stockStatusText(variantChoice(page));
    await expect(status).toHaveText(/^In Stock · /);

    await page.route('**/admin/inventory-items*', async (route) => {
      delayed += 1;
      await new Promise((resolve) => setTimeout(resolve, 750));
      await route.continue();
    });
    await setInventoryLevel(token, inventoryItemId, locationId, 0);
    await triggerReconcile(page);

    await expect(status).toHaveText(/^Out of Stock · /);
    expect(delayed).toBeGreaterThan(0);
  } finally {
    await page.unrouteAll({ behavior: 'wait' });
    await setInventoryLevel(token, inventoryItemId, locationId, original);
  }
});

test('a stock warning triggers a pass', async ({ page }) => {
  const token = await adminToken();
  const { inventoryItemId, locationId, stockedQuantity: original } = await inventoryLevel(token, 'E2E-4B');
  const variantId = await variantIdBySku(token, 'E2E-4B');
  try {
    await signIn(page);
    await setInventoryLevel(token, inventoryItemId, locationId, 0);

    await page.route('**/tally/v1/commands', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      for (const result of body.results ?? []) {
        result.warnings = [...(result.warnings ?? []), { code: 'insufficient_stock', variantId, quantity: 1 }];
      }
      await route.fulfill({ response, json: body });
    });
    await sellBySku(page, ['E2E-1'], 'exact');
    // sellBySku returns as soon as the sale completes locally (optimistic UI), which can race the
    // route handler above still finishing its own fetch()/fulfill(): unroute() would auto-continue
    // a still-pending route, sending a second real request and racing the first one. Wait for the
    // sync to actually settle first, then it's safe to stop intercepting.
    await expect(page.getByLabel('Sync status', { exact: true })).toHaveText('All sales synced');
    await page.unroute('**/tally/v1/commands');

    // No visibility change here: the applied order carrying an insufficient_stock warning is
    // what triggers the pass (app/index.tsx).
    await expect(async () => {
      await openChooser(page);
      await expect(stockStatusText(variantChoice(page))).toHaveText(/^Out of Stock · /, { timeout: 1_000 });
    }).toPass({ timeout: 30_000 });
  } finally {
    await setInventoryLevel(token, inventoryItemId, locationId, original);
  }
});
