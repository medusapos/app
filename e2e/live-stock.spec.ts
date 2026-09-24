import { expect, test, type Page } from '@playwright/test';
import { adminToken, inventoryLevel, sellBySku, setInventoryLevel, signIn, variantIdBySku } from './helpers';

const PRODUCT_4 = 'E2E product 4';

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
  try {
    await signIn(page);
    await openChooser(page);
    const before = await stockStatusText(variantChoice(page)).textContent();
    if (!before) throw new Error('No stock status text found for E2E-4B');
    const beforeMinutes = asOfMinutes(before);

    // Flip the status server-side (0 reads Out of Stock), then reconcile without any catalogue
    // pull (no reload, no new sign-in).
    await setInventoryLevel(token, inventoryItemId, locationId, 0);
    await triggerReconcile(page);

    let after = '';
    await expect(async () => {
      // The already-open chooser is a snapshot taken when it was opened; re-opening it (a normal
      // cashier action, not a reload or sign-in) re-reads the reconciled overlay.
      await openChooser(page);
      const status = stockStatusText(variantChoice(page));
      await expect(status).toHaveText(/^Out of Stock · /);
      after = (await status.textContent()) ?? '';
    }).toPass({ timeout: 30_000 });

    expect(after).not.toBe(before);
    expect(asOfMinutes(after)).toBeGreaterThanOrEqual(beforeMinutes);
  } finally {
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
      await expect(stockStatusText(variantChoice(page))).toHaveText(/^Out of Stock · /);
    }).toPass({ timeout: 30_000 });
  } finally {
    await setInventoryLevel(token, inventoryItemId, locationId, original);
  }
});
