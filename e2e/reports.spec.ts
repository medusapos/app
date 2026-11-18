import { expect } from '@playwright/test';
import { openArea, signIn, test } from './helpers';

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
});
