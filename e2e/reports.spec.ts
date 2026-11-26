import { expect, type Page } from '@playwright/test';
import { adminToken, inventoryLevel, openArea, refundInModal, sellBySku, setInventoryLevel, signIn, test } from './helpers';

async function openNewestSale(page: Page) {
  await openArea(page, 'Orders');
  await page.getByRole('button', { name: /^Open order / }).first().click();
  const sheet = page.getByTestId('order-detail-sheet');
  await expect(sheet.getByTestId('order-detail')).toBeVisible();
  return sheet;
}

// A shown amount in minor units (the e2e store's currency has two decimals), whatever its symbol and separators.
const minorOf = (text: string | null) => Number((text ?? '').replace(/\D/g, ''));

// The Refunds card's amount and its panel's count; the card reads "None in this period" until there is a refund.
async function refundsShown(page: Page): Promise<{ count: number; amountMinor: number }> {
  const card = page.getByTestId('card-refunds');
  await expect(card).toBeVisible();
  if (await card.getByTestId('card-refunds-none').count() > 0) return { count: 0, amountMinor: 0 };
  const amountMinor = minorOf(await card.getByTestId('card-refunds-figure').textContent());
  await page.getByTestId('card-refunds-open').click();
  const sheet = page.getByTestId('report-sheet');
  const cells = sheet.getByTestId('report-sheet-row').getByRole('cell');
  const count = Number(await cells.nth(1).textContent());
  expect(minorOf(await cells.nth(2).textContent())).toBe(amountMinor);
  await sheet.getByTestId('report-sheet-close').click();
  await expect(sheet).toHaveCount(0);
  return { count, amountMinor };
}

// v2's Print summary: the button closes the Sales filter row and prints the period's figures through the print frame.
test.describe('at 1280 × 800', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('Print summary sits on the filter row and prints the sales summary', async ({ page }) => {
    await signIn(page);
    await openArea(page, 'Reports');
    const button = page.getByTestId('reports-print-summary');
    await expect(button).toBeVisible();
    const filters = await page.getByTestId('sales-filters').boundingBox();
    const box = await button.boundingBox();
    expect(filters && box).toBeTruthy();
    // Same row: the button's vertical range overlaps the filters' first row (the bar's top 44 px, one control high).
    expect(box!.y).toBeLessThan(filters!.y + 44);
    expect(box!.y + box!.height).toBeGreaterThan(filters!.y);
    await button.click();
    const frame = page.frameLocator('#closure-print-frame');
    await expect(frame.locator('h2')).toHaveText('Sales summary');
    // The frame is 0 × 0 (printed, never shown), so read its text rather than its visibility.
    await expect(frame.locator('table.total th')).toHaveText('Total sales');
    await expect(page.getByTestId('reports-print-summary-error')).toHaveCount(0);
  });

  test('a Sales card opens its report in the side sheet, which prints it', async ({ page }) => {
    await signIn(page);
    await openArea(page, 'Reports');
    await page.getByTestId('card-products-open').click();
    const sheet = page.getByTestId('report-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId('report-sheet-title')).toHaveText('Top products');
    await expect(sheet.getByTestId('report-sheet-status')).toBeVisible();
    await expect(sheet.getByTestId('report-sheet-export')).toBeVisible();
    await expect(sheet.getByTestId('report-sheet-print')).toBeVisible();
    await sheet.getByTestId('report-sheet-print').click();
    await expect(page.frameLocator('#closure-print-frame').locator('h2')).toHaveText('Top products');
    await sheet.getByTestId('report-sheet-close').click();
    await expect(page.getByTestId('report-sheet')).toHaveCount(0);
  });

  // The store's refunds of the till's own sales fill the Refunds card (AUDIT 17, 19); E2E-1's stock is put back.
  test('a refunded sale shows in the Refunds card', async ({ page }) => {
    const token = await adminToken();
    const start = await inventoryLevel(token, 'E2E-1');
    try {
      await signIn(page);
      await sellBySku(page, ['E2E-1', 'E2E-1'], 'exact');
      await expect(page.getByText('Sales are up to date.', { exact: true })).toBeVisible();
      await openArea(page, 'Reports');
      const hero = page.getByTestId('hero-total');
      await expect.poll(async () => minorOf(await hero.textContent())).toBeGreaterThan(0);
      // This browser's till holds only the sale above, so the store's other refunds never count here.
      const grossBefore = await hero.textContent();
      const before = await refundsShown(page);

      const sheet = await openNewestSale(page);
      await expect(sheet.getByTestId('order-detail-refund')).toBeVisible({ timeout: 15_000 });
      await sheet.getByTestId('order-detail-refund').click();
      const refundMinor = await refundInModal(page, { reason: 'e2e reports refund' });
      expect(refundMinor).toBeGreaterThan(0);
      await expect(sheet.getByTestId('order-detail-refunded')).toBeVisible();
      await sheet.getByTestId('order-detail-close').click();

      await openArea(page, 'Reports');
      await expect.poll(async () => minorOf(await page.getByTestId('card-refunds-figure').textContent()), { timeout: 15_000 })
        .toBe(before.amountMinor + refundMinor);
      expect(await refundsShown(page)).toEqual({ count: before.count + 1, amountMinor: before.amountMinor + refundMinor });
      await expect(hero).toHaveText(grossBefore ?? '');
    } finally {
      const now = await inventoryLevel(token, 'E2E-1');
      if (now.stockedQuantity !== start.stockedQuantity) await setInventoryLevel(token, start.inventoryItemId, start.locationId, start.stockedQuantity);
    }
  });
});
