import { expect, type Page } from '@playwright/test';
import { adminToken, inventoryLevel, openArea, refundInModal, sellBySku, setInventoryLevel, signIn, test } from './helpers';

// Partial refunds (#569): order.refund v1 for this till's synced sale, from the Orders sheet's refund form. E2E-1's stock
// (50) is shared across specs, so each test puts it back where it found it.
test.use({ viewport: { width: 1280, height: 800 } });

const minorOf = (text: string | null) => Number((text ?? '').replace(/\D/g, ''));

async function openNewestSale(page: Page) {
  await openArea(page, 'Orders');
  await page.getByRole('button', { name: /^Open order / }).first().click();
  const sheet = page.getByTestId('order-detail-sheet');
  await expect(sheet.getByTestId('order-detail')).toBeVisible();
  return sheet;
}

async function reopenNewestSale(page: Page) {
  const sheet = page.getByTestId('order-detail-sheet');
  await sheet.getByTestId('order-detail-close').click();
  await expect(sheet).toHaveCount(0);
  await page.getByRole('button', { name: /^Open order / }).first().click();
  await expect(sheet.getByTestId('order-detail')).toBeVisible();
  return sheet;
}

test('Two refunds on a cash sale: one unit, then the last unit, restocking each; no third refund', async ({ page }) => {
  const token = await adminToken();
  const start = await inventoryLevel(token, 'E2E-1');
  try {
    await signIn(page);
    const totalMinor = Math.round(await sellBySku(page, ['E2E-1', 'E2E-1'], 'exact') * 100);
    await expect(page.getByText('Sales are up to date.', { exact: true })).toBeVisible();
    await expect.poll(async () => (await inventoryLevel(token, 'E2E-1')).stockedQuantity).toBe(start.stockedQuantity - 2);

    let sheet = await openNewestSale(page);
    await expect(sheet.getByTestId('order-detail-refund')).toBeVisible({ timeout: 15_000 });
    await sheet.getByTestId('order-detail-refund').click();
    await expect(page.getByTestId('refund-previously-refunded')).toHaveCount(0);
    const first = await refundInModal(page, { units: 1, reason: 'e2e refund one unit' });
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(totalMinor);
    await expect(sheet.getByTestId('order-detail-refunded')).toBeVisible();
    await expect.poll(async () => (await inventoryLevel(token, 'E2E-1')).stockedQuantity).toBe(start.stockedQuantity - 1);

    // Refund comes back once the store's copy carries the first refund, with what is left of the line.
    sheet = await reopenNewestSale(page);
    await expect(sheet.getByTestId('order-detail-refund')).toBeVisible({ timeout: 15_000 });
    await sheet.getByTestId('order-detail-refund').click();
    await expect(page.getByTestId('refund-previously-refunded')).toBeVisible();
    const second = await refundInModal(page, { reason: 'e2e refund the rest' });
    expect(first + second).toBe(totalMinor);
    await expect.poll(async () => (await inventoryLevel(token, 'E2E-1')).stockedQuantity).toBe(start.stockedQuantity);

    sheet = await reopenNewestSale(page);
    await expect.poll(async () => minorOf(await sheet.getByTestId('order-detail-refunded').textContent()), { timeout: 15_000 })
      .toBe(totalMinor);
    await expect(sheet.getByTestId('order-detail-refund')).toHaveCount(0);
  } finally {
    const now = await inventoryLevel(token, 'E2E-1');
    if (now.stockedQuantity !== start.stockedQuantity) await setInventoryLevel(token, start.inventoryItemId, start.locationId, start.stockedQuantity);
  }
});

// #644: a refund with no lines (here an adjustment only) used to lock the order: the next refund read lines_unknown.
test('A refund with no lines, then the last units: Refund is offered again; no third refund', async ({ page }) => {
  const token = await adminToken();
  const start = await inventoryLevel(token, 'E2E-1');
  try {
    await signIn(page);
    const totalMinor = Math.round(await sellBySku(page, ['E2E-1', 'E2E-1'], 'exact') * 100);
    await expect(page.getByText('Sales are up to date.', { exact: true })).toBeVisible();
    await expect.poll(async () => (await inventoryLevel(token, 'E2E-1')).stockedQuantity).toBe(start.stockedQuantity - 2);

    let sheet = await openNewestSale(page);
    await expect(sheet.getByTestId('order-detail-refund')).toBeVisible({ timeout: 15_000 });
    await sheet.getByTestId('order-detail-refund').click();
    const first = await refundInModal(page, { units: 0, adjustment: '1.00', reason: 'e2e adjustment only' });
    expect(first).toBe(100);
    await expect(sheet.getByTestId('order-detail-refunded')).toBeVisible();

    sheet = await reopenNewestSale(page);
    await expect(sheet.getByTestId('order-detail-refund')).toBeVisible({ timeout: 15_000 });
    await sheet.getByTestId('order-detail-refund').click();
    await expect(page.getByTestId('refund-previously-refunded')).toBeVisible();
    // C10 (#636): the earlier goodwill caps the last units; the cashier enters it back as a negative adjustment.
    const modal = page.getByTestId('refund-modal');
    const stepper = modal.locator('[data-testid^="refund-qty-"]').first();
    const lineId = ((await stepper.getAttribute('data-testid')) ?? '').slice('refund-qty-'.length);
    const remaining = Number(await modal.getByTestId(`refund-remaining-${lineId}`).textContent());
    expect(remaining).toBe(2);
    for (let press = 0; press < remaining; press++) await stepper.getByText('+', { exact: true }).click();
    await expect(modal.getByTestId('refund-invalid')).toContainText('You can refund at most');
    expect(minorOf(await modal.getByTestId('refund-invalid').textContent())).toBe(totalMinor - 100);
    await expect(modal.getByTestId('refund-submit')).toBeDisabled();
    const second = await refundInModal(page, { units: 0, adjustment: '-1.00', reason: 'e2e refund the rest' });
    expect(second).toBe(totalMinor - 100);
    expect(first + second).toBe(totalMinor);
    await expect.poll(async () => (await inventoryLevel(token, 'E2E-1')).stockedQuantity).toBe(start.stockedQuantity);

    sheet = await reopenNewestSale(page);
    await expect.poll(async () => minorOf(await sheet.getByTestId('order-detail-refunded').textContent()), { timeout: 15_000 })
      .toBe(totalMinor);
    await expect(sheet.getByTestId('order-detail-refund')).toHaveCount(0);
  } finally {
    const now = await inventoryLevel(token, 'E2E-1');
    if (now.stockedQuantity !== start.stockedQuantity) await setInventoryLevel(token, start.inventoryItemId, start.locationId, start.stockedQuantity);
  }
});

test('A card sale offers Refund to Card (label only)', async ({ page }) => {
  const token = await adminToken();
  const start = await inventoryLevel(token, 'E2E-1');
  try {
    await signIn(page);
    await sellBySku(page, ['E2E-1'], 'external');
    await expect(page.getByText('Sales are up to date.', { exact: true })).toBeVisible();
    const sheet = await openNewestSale(page);
    await expect(sheet.getByTestId('order-detail-refund')).toBeVisible({ timeout: 15_000 });
    await sheet.getByTestId('order-detail-refund').click();
    const modal = page.getByTestId('refund-modal');
    await expect(modal.getByTestId('refund-destination-original_method')).toHaveText(/^Refund to Card/);
    await modal.getByTestId('refund-cancel').click();
    await expect(modal).toHaveCount(0);
  } finally {
    const now = await inventoryLevel(token, 'E2E-1');
    if (now.stockedQuantity !== start.stockedQuantity) await setInventoryLevel(token, start.inventoryItemId, start.locationId, start.stockedQuantity);
  }
});
