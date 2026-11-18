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
  await expect(page.getByTestId('products-footer')).toHaveText(/^Showing 1 of \d+$/);
});

test('the Products area narrows by category chip and shows each row\'s stock status and category', async ({ page }) => {
  await signIn(page);
  await openArea(page, 'Products');
  const categories = page.getByRole('radiogroup', { name: 'Categories' });
  const chip = (name: string) => categories.getByRole('radio', { name, exact: true });
  for (const name of ['All products', 'Drinks', 'Food']) await expect(chip(name)).toBeVisible();
  await expect(chip('All products')).toBeChecked();
  const rows = page.locator('[data-testid^="product-row-"]');
  const first = rows.filter({ hasText: 'E2E product 1' }).filter({ hasText: 'E2E-1' }).first();
  await expect(first).toContainText('Drinks');
  await expect(first.locator('[data-testid^="product-stock-status-"]')).toHaveText('In stock');
  await chip('Food').click();
  await expect(rows.filter({ hasText: 'E2E product 1' })).toHaveCount(0);
  await expect(rows.first()).toBeVisible();
  for (const row of await rows.all()) await expect(row).toContainText('E2E product 3');
  await chip('All products').click();
  await expect(first).toBeVisible();
});

test('the Products area loads the catalogue itself when opened without the Sale', async ({ page }) => {
  await signIn(page, 'Europe', false);
  // A fresh page load with the saved session: no Sale is mounted beneath the areas.
  await page.goto('/orders');
  await openArea(page, 'Products');
  await expect(page).toHaveURL(/\/products$/);
  await expect(page.locator('[data-testid^="product-row-"]', { hasText: 'E2E product 1' }).filter({ hasText: 'E2E-1' }).first())
    .toBeVisible();
  await expect(page.getByTestId('products-loading')).toHaveCount(0);
  await expect(page.getByTestId('products-error')).toHaveCount(0);
  await expect(page.getByText(/Up to date · /)).toHaveCount(0);
});

test('the Products area keeps its category across a page load and narrows with an In stock chip that it does not keep', async ({ page }) => {
  await signIn(page);
  await openArea(page, 'Products');
  const categories = page.getByRole('radiogroup', { name: 'Categories' });
  const chip = (name: string) => categories.getByRole('radio', { name, exact: true });
  const rows = page.locator('[data-testid^="product-row-"]');
  await chip('Food').click();
  await expect(chip('Food')).toBeChecked();
  // A fresh page load: the category is read back from this device's storage.
  await page.goto('/orders');
  await openArea(page, 'Products');
  await expect(chip('Food')).toBeChecked();
  await expect(rows.filter({ hasText: 'E2E product 3' }).first()).toBeVisible();
  await expect(rows.filter({ hasText: 'E2E product 1' })).toHaveCount(0);
  const inStock = page.getByRole('button', { name: 'In stock', exact: true });
  await expect(inStock).toBeVisible();
  await expect(inStock).toHaveAttribute('aria-pressed', 'false');
  await inStock.click();
  await expect(inStock).toHaveAttribute('aria-pressed', 'true');
  await expect(rows.filter({ hasText: 'E2E product 3' }).first()).toBeVisible();
  await chip('All products').click();
  await expect(chip('All products')).toBeChecked();
});

test('on a phone the Products area lists two-line rows, not the table, and finds a variant by SKU', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await signIn(page);
  await openArea(page, 'Products');
  await expect(page.getByTestId('products-list')).toBeVisible();
  await expect(page.getByTestId('products-table')).toHaveCount(0);
  await expect(page.getByTestId('products-footer')).toBeVisible();
  const rows = page.locator('[data-testid^="product-list-row-"]');
  const first = rows.filter({ hasText: 'E2E product 1' }).filter({ hasText: 'E2E-1' }).first();
  await expect(first).toBeVisible();
  await expect(first.locator('[data-testid^="product-stock-status-"]')).toContainText('In stock');
  await page.getByTestId('products-search').fill('E2E-4B');
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('E2E product 4 · B');
});
