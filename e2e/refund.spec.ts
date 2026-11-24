import { expect, type Page } from '@playwright/test';
import { adminToken, inventoryLevel, openArea, sellBySku, setInventoryLevel, signIn, test } from './helpers';

// Refund all (ADR 0026): one order.refund v1 for this till's synced sale, from the Orders sheet. E2E-1's stock (50) is
// shared across specs, so each test puts it back where it found it.
test.use({ viewport: { width: 1280, height: 800 } });

async function openNewestSale(page: Page) {
  await openArea(page, 'Orders');
  await page.getByRole('button', { name: /^Open order / }).first().click();
  const sheet = page.getByTestId('order-detail-sheet');
  await expect(sheet.getByTestId('order-detail')).toBeVisible();
  return sheet;
}

test('Refund all on a cash sale refunds its total to cash, restocks, and offers no second refund', async ({ page }) => {
  const token = await adminToken();
  const start = await inventoryLevel(token, 'E2E-1');
  try {
    await signIn(page);
    const total = await sellBySku(page, ['E2E-1', 'E2E-1'], 'exact');
    await expect(page.getByText('Sales are up to date.', { exact: true })).toBeVisible();
    await expect.poll(async () => (await inventoryLevel(token, 'E2E-1')).stockedQuantity).toBe(start.stockedQuantity - 2);

    const sheet = await openNewestSale(page);
    await expect(sheet.getByTestId('order-detail-refund')).toBeVisible({ timeout: 15_000 });
    await sheet.getByTestId('order-detail-refund').click();
    const dialog = page.getByTestId('order-refund-dialog');
    const shown = (await dialog.getByTestId('order-refund-total').textContent()) ?? '';
    expect(Number(shown.replace(/[^\d.,]/g, '').replace(',', '.'))).toBe(total);
    await expect(dialog.getByTestId('order-refund-destination')).toHaveText('To Cash');
    await dialog.getByTestId('order-refund-reason').fill('e2e refund');
    await dialog.getByTestId('order-refund-confirm').click();
    // Polled as text, so a refusal fails with the store's own message.
    await expect.poll(async () => await dialog.count() === 0 ? 'closed'
      : (await dialog.getByTestId('order-refund-error').allTextContents()).join(' | ') || 'open').toBe('closed');
    await expect(sheet.getByTestId('order-detail-refunded')).toBeVisible();

    await sheet.getByTestId('order-detail-close').click();
    await expect(sheet).toHaveCount(0);
    await page.getByRole('button', { name: /^Open order / }).first().click();
    await expect(page.getByTestId('order-detail-refunded')).toBeVisible();
    await expect(page.getByTestId('order-detail-refund')).toHaveCount(0);
    await expect.poll(async () => (await inventoryLevel(token, 'E2E-1')).stockedQuantity).toBe(start.stockedQuantity);
  } finally {
    const now = await inventoryLevel(token, 'E2E-1');
    if (now.stockedQuantity !== start.stockedQuantity) await setInventoryLevel(token, start.inventoryItemId, start.locationId, start.stockedQuantity);
  }
});

test('A card sale refunds to the card (label only)', async ({ page }) => {
  const token = await adminToken();
  const start = await inventoryLevel(token, 'E2E-1');
  try {
    await signIn(page);
    await sellBySku(page, ['E2E-1'], 'external');
    await expect(page.getByText('Sales are up to date.', { exact: true })).toBeVisible();
    const sheet = await openNewestSale(page);
    await expect(sheet.getByTestId('order-detail-refund')).toBeVisible({ timeout: 15_000 });
    await sheet.getByTestId('order-detail-refund').click();
    await expect(page.getByTestId('order-refund-destination')).toHaveText(/^To Card/);
    await page.getByTestId('order-refund-cancel').click();
    await expect(page.getByTestId('order-refund-dialog')).toHaveCount(0);
  } finally {
    const now = await inventoryLevel(token, 'E2E-1');
    if (now.stockedQuantity !== start.stockedQuantity) await setInventoryLevel(token, start.inventoryItemId, start.locationId, start.stockedQuantity);
  }
});
