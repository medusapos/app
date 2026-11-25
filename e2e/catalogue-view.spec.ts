import { expect, type Page } from '@playwright/test';
import { expectSwitchThumbInTrack, signIn, test } from './helpers';

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

    // TallyUI 4.0.0's view toggle: one icon button, named for the view a press switches to.
    const view = page.getByTestId('view-toggle');
    await expect(view.getByTestId('view-toggle-table')).toHaveAttribute('aria-label', 'Switch to table view');
    await view.getByTestId('view-toggle-table').click();
    await expect(page.getByTestId('product-table-sort-name')).toBeVisible();
    await expect(page.getByTestId(/^product-tile-/)).toHaveCount(0);
    await expect(view.getByTestId('view-toggle-grid')).toHaveAttribute('aria-label', 'Switch to grid view');
    await page.reload();
    await expect(page.getByText(/Up to date · 5 products/)).toBeVisible();
    await expect(view.getByTestId('view-toggle-grid')).toHaveAttribute('aria-label', 'Switch to grid view');
    await expect(page.getByTestId('product-table-sort-name')).toBeVisible();
  });

  test('Browse by Categories opens the Sale on category tiles, a tile opens its category, and it survives a reload until Restore', async ({ page }) => {
    await signIn(page, 'Europe', false);
    await page.getByTestId('product-settings-button').click();
    await page.getByTestId('product-settings-browse-tiles').click();
    await expect(page.getByTestId('product-settings-browse-tiles')).toHaveAttribute('aria-selected', 'true');
    await page.getByTestId('product-settings-close').click();
    const browse = page.getByTestId('category-browse');
    const drinks = browse.getByRole('button', { name: 'Drinks', exact: true });
    await expect(page.getByTestId('category-tile-all')).toBeVisible();
    await expect(drinks).toContainText('2 products');
    await expect(browse.getByRole('button', { name: 'Food', exact: true })).toBeVisible();
    await expect(page.getByTestId(/^product-tile-/)).toHaveCount(0);
    await drinks.click();
    await expect(tile(page, 'E2E product 1')).toBeVisible();
    await expect(tile(page, 'E2E product 2')).toBeVisible();
    await expect(page.getByTestId(/^product-tile-/)).toHaveCount(2);
    await page.getByTestId('category-crumb-root').click();
    await expect(drinks).toBeVisible();

    await page.reload();
    await expect(page.getByText(/Up to date · 5 products/)).toBeVisible();
    await expect(page.getByTestId('category-tile-all')).toBeVisible();
    await page.getByTestId('product-settings-button').click();
    await page.getByTestId('product-settings-restore').click();
    await expect(page.getByTestId('product-settings-browse-chips')).toHaveAttribute('aria-selected', 'true');
    await page.getByTestId('product-settings-close').click();
    await expect(categories(page).getByRole('radio', { name: 'Drinks', exact: true })).toBeVisible();
    await expect(page.getByTestId('category-tile-all')).toHaveCount(0);
  });

  test('the sale screen\'s Product and Cart Settings switch thumbs sit inside their tracks, at the start off and the end on', async ({ page }) => {
    await signIn(page);
    for (const [sheet, ids] of [['product', ['product-settings-out-of-stock']],
      ['cart', ['cart-settings-auto-show-receipt', /^cart-settings-column-/]]] as const) {
      await page.getByTestId(`${sheet}-settings-button`).click();
      await expect(page.getByTestId(`${sheet}-settings-sheet`)).toBeVisible();
      for (const id of ids) {
        const matched = page.getByTestId(id);
        await expect(matched.first()).toBeVisible();
        for (const sw of await matched.all()) {
          const was = (await sw.getAttribute('aria-checked')) === 'true';
          await expectSwitchThumbInTrack(sw);
          await sw.click();
          await expect(sw).toHaveAttribute('aria-checked', String(!was));
          await expectSwitchThumbInTrack(sw);
          await sw.click();
          await expect(sw).toHaveAttribute('aria-checked', String(was));
          await expectSwitchThumbInTrack(sw);
        }
      }
      await page.getByTestId(`${sheet}-settings-close`).click();
      await expect(page.getByTestId(`${sheet}-settings-sheet`)).not.toBeVisible();
    }
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
