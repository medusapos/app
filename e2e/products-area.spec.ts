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

test('the Products area\'s settings sheet hides a column, keeps it across a page load, and restores the defaults', async ({ page }) => {
  await signIn(page);
  await openArea(page, 'Products');
  const table = page.getByTestId('products-table');
  // A head's text, past the sort arrow the sorted column carries ("Product ▲").
  const head = (name: string) => table.getByRole('columnheader').filter({ hasText: new RegExp(`^${name}( [▲▼])?$`) });
  await expect(head('SKU')).toBeVisible();
  await page.getByTestId('products-settings-button').click();
  await expect(page.getByRole('dialog').getByText('Product Settings', { exact: true })).toBeVisible();
  await page.getByTestId('products-settings-column-sku').click();
  await expect(page.getByTestId('products-settings-column-sku')).toHaveAttribute('aria-checked', 'false');
  await page.getByTestId('products-settings-close').click();
  await expect(page.getByTestId('products-settings-sheet')).not.toBeVisible();
  await expect(head('Product')).toBeVisible();
  await expect(head('SKU')).toHaveCount(0);
  // A fresh page load: the choice is read back from this device's storage.
  await page.reload();
  await expect(head('Product')).toBeVisible();
  await expect(head('SKU')).toHaveCount(0);
  await page.getByTestId('products-settings-button').click();
  await page.getByTestId('products-settings-restore').click();
  await page.getByTestId('products-settings-close').click();
  await expect(head('SKU')).toBeVisible();
});

test('the Products area\'s settings sheet shows v2\'s ID and Barcode columns, off until switched on', async ({ page }) => {
  await signIn(page);
  await openArea(page, 'Products');
  const table = page.getByTestId('products-table');
  // A head's text, past the sort arrow the sorted column carries ("Product ▲").
  const head = (name: string) => table.getByRole('columnheader').filter({ hasText: new RegExp(`^${name}( [▲▼])?$`) });
  await expect(head('Product')).toBeVisible();
  await expect(head('ID')).toHaveCount(0);
  await expect(head('Barcode')).toHaveCount(0);
  await page.getByTestId('products-settings-button').click();
  await page.getByTestId('products-settings-column-barcode').click();
  await page.getByTestId('products-settings-column-id').click();
  await expect(page.getByTestId('products-settings-column-id')).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('products-settings-close').click();
  await expect(head('Barcode')).toBeVisible();
  await expect(head('ID')).toBeVisible();
  const first = page.locator('[data-testid^="product-row-"]', { hasText: 'E2E product 1' }).filter({ hasText: 'E2E-1' }).first();
  await expect(first).toContainText('2000000000011');
  // The ID cell shows the row's own Medusa variant id.
  const id = (await first.getAttribute('data-testid'))?.replace(/^product-row-/, '') ?? '';
  expect(id).toMatch(/^variant_/);
  await expect(first).toContainText(id);
  await page.getByTestId('products-settings-button').click();
  await page.getByTestId('products-settings-restore').click();
  await page.getByTestId('products-settings-close').click();
  await expect(head('ID')).toHaveCount(0);
  await expect(head('Barcode')).toHaveCount(0);
});

test('the Products area\'s settings sheet lists v2\'s Image switch first, on, and each row shows its image tile', async ({ page }) => {
  await signIn(page);
  await openArea(page, 'Products');
  const table = page.getByTestId('products-table');
  const first = table.locator('[data-testid^="product-row-"]', { hasText: 'E2E product 1' }).filter({ hasText: 'E2E-1' }).first();
  await expect(first).toBeVisible();
  const id = (await first.getAttribute('data-testid'))?.replace(/^product-row-/, '') ?? '';
  // The e2e products have no thumbnail, so each row shows the plain tile.
  await expect(first.getByTestId(`product-image-placeholder-${id}`)).toBeVisible();
  await page.getByTestId('products-settings-button').click();
  const image = page.getByTestId('products-settings-column-image');
  await expect(page.locator('[data-testid^="products-settings-column-"]').first())
    .toHaveAttribute('data-testid', 'products-settings-column-image');
  await expect(image).toHaveAttribute('aria-checked', 'true');
  await image.click();
  await expect(image).toHaveAttribute('aria-checked', 'false');
  await page.getByTestId('products-settings-close').click();
  await expect(first).toBeVisible();
  await expect(table.locator('[data-testid^="product-image-"]')).toHaveCount(0);
  await page.getByTestId('products-settings-button').click();
  await page.getByTestId('products-settings-restore').click();
  await page.getByTestId('products-settings-close').click();
  await expect(first.getByTestId(`product-image-placeholder-${id}`)).toBeVisible();
});

test('the Products area\'s settings switches show whole inside the sheet at 1280 wide', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await signIn(page);
  await openArea(page, 'Products');
  await page.getByTestId('products-settings-button').click();
  const sheet = page.getByTestId('products-settings-sheet');
  const root = (id: string) => page.getByTestId(`products-settings-column-${id}`);
  const box = async (id: string) => {
    const r = await root(id).boundingBox();
    const t = await root(id).locator('> *').first().boundingBox();
    if (!r || !t) throw new Error(`no box for ${id}`);
    return { r, t, inside: t.x >= r.x - 0.5 && t.x + t.width <= r.x + r.width + 0.5, offset: t.x + t.width / 2 - (r.x + r.width / 2) };
  };
  for (const id of ['id', 'barcode']) {
    await root(id).click();
    await expect(root(id)).toHaveAttribute('aria-checked', 'true');
  }
  const ids = ['id', 'sku', 'barcode', 'stock', 'stockStatus', 'category', 'price'];
  await expect(async () => {
    const s = await sheet.boundingBox();
    if (!s) throw new Error('no sheet box');
    for (const id of ids) {
      const { r, t, inside, offset } = await box(id);
      console.log(`switch ${id}: root ${r.x}-${r.x + r.width}, thumb ${t.x}-${t.x + t.width}, sheet ${s.x}-${s.x + s.width}`);
      expect(inside, `${id} thumb inside its root`).toBe(true);
      expect(offset, `${id} thumb centre right of the root centre`).toBeGreaterThan(0);
      expect(r.x + r.width, `${id} root inside the sheet's padding`).toBeLessThanOrEqual(s.x + s.width - 24 + 0.5);
    }
  }).toPass();
  await root('id').click();
  await expect(root('id')).toHaveAttribute('aria-checked', 'false');
  await expect(async () => {
    const { r, t, inside, offset } = await box('id');
    console.log(`switch id off: root ${r.x}-${r.x + r.width}, thumb ${t.x}-${t.x + t.width}`);
    expect(inside, 'id thumb inside its root').toBe(true);
    expect(offset, 'id thumb centre left of the root centre').toBeLessThan(0);
  }).toPass();
  await page.getByTestId('products-settings-restore').click();
  await page.getByTestId('products-settings-close').click();
});
