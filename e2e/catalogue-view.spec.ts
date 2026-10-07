import { expect, type Page } from '@playwright/test';
import { signIn, test } from './helpers';

// The catalogue's category nav and grid/table toggle (V2-PARITY, Products and search). The e2e seed puts E2E products
// 1 and 2 in Drinks and 3 in Food; 4 and 5 have no category. The view is kept per store on this device.
const categories = (page: Page) => page.getByRole('radiogroup', { name: 'Categories' });
const tile = (page: Page, name: string) => page.getByTestId(`product-tile-${name}`);

test.describe('at 1280 × 800', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('a category narrows the catalogue, All products restores it, and the table view survives a reload', async ({ page }) => {
    await signIn(page, 'Europe', false);
    for (const name of ['All products', 'Drinks', 'Food']) await expect(categories(page).getByRole('radio', { name, exact: true })).toBeVisible();
    await expect(categories(page).getByRole('radio', { name: 'All products', exact: true })).toBeChecked();
    await categories(page).getByRole('radio', { name: 'Food', exact: true }).click();
    await expect(tile(page, 'E2E product 3')).toBeVisible();
    await expect(tile(page, 'E2E product 1')).toHaveCount(0);
    await expect(page.getByTestId(/^product-tile-/)).toHaveCount(1);
    await categories(page).getByRole('radio', { name: 'All products', exact: true }).click();
    await expect(page.getByTestId(/^product-tile-/)).toHaveCount(5);

    const view = page.getByRole('radiogroup', { name: 'View' });
    await expect(view.getByTestId('view-toggle-grid')).toBeChecked();
    await view.getByTestId('view-toggle-table').click();
    await expect(page.getByTestId('product-table-sort-name')).toBeVisible();
    await expect(page.getByTestId(/^product-tile-/)).toHaveCount(0);
    await page.reload();
    await expect(page.getByText(/Up to date · 5 products/)).toBeVisible();
    await expect(view.getByTestId('view-toggle-table')).toBeChecked();
    await expect(page.getByTestId('product-table-sort-name')).toBeVisible();
  });
});

test.describe('at 360 × 780', () => {
  test.use({ viewport: { width: 360, height: 780 } });

  test('a phone shows the category nav and no grid/table toggle', async ({ page }) => {
    await signIn(page, 'Europe', false);
    await expect(categories(page).getByRole('radio', { name: 'Food', exact: true })).toBeVisible();
    await expect(page.getByTestId('view-toggle')).toHaveCount(0);
    await expect(tile(page, 'E2E product 1')).toBeVisible();
  });
});
