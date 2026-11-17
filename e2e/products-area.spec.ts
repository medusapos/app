import { expect } from '@playwright/test';
import { openArea, signIn, test } from './helpers';

test('the Products area lists the catalogue read-only and finds a variant by SKU', async ({ page }) => {
  await signIn(page);
  await openArea(page, 'Products');
  await expect(page).toHaveURL(/\/products$/);
  await expect(page.getByTestId('products-admin-note')).toBeVisible();
  await expect(page.locator('[data-testid^="product-row-"]', { hasText: 'E2E product 1' }).filter({ hasText: 'E2E-1' }).first())
    .toBeVisible();
  await page.getByTestId('products-search').fill('E2E-4B');
  const rows = page.locator('[data-testid^="product-row-"]');
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('E2E product 4 · B');
});
