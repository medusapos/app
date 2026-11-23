import { expect, type Locator, type Page } from '@playwright/test';
import { addE2E1, cartTab, signIn, test } from './helpers';

// The cart "+" menu closes, as in v2, on a click anywhere else (row 05a.7) and on Escape. The click that closes it
// does nothing more: it lands on the menu's overlay, not on the tile or button under it.
const menu = (page: Page) => page.getByRole('menu');
const lines = (page: Page) => page.getByRole('button', { name: /^Edit quantity of / });

async function openMenu(page: Page) {
  await page.getByTestId('cart-add-menu').click();
  await expect(menu(page)).toBeVisible();
  await expect(page.getByTestId('cart-add-menu-overlay')).toHaveCount(1);
}

// A real pointer click at the target's centre: Playwright's own click would wait for the overlay to stop covering it.
async function clickThrough(page: Page, target: Locator) {
  const box = (await target.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

test.describe('at 1280 × 800', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('a click on a product tile closes the "+" menu without adding it, and Escape closes the menu', async ({ page }) => {
    await signIn(page);
    await expect(lines(page)).toHaveCount(0);
    const tile = page.getByTestId('product-tile-E2E product 1');
    await openMenu(page);
    await clickThrough(page, tile);
    await expect(menu(page)).toHaveCount(0);
    await expect(page.getByTestId('cart-add-menu-overlay')).toHaveCount(0);
    await expect(page.getByTestId('cart-add-menu')).toHaveAttribute('data-open', 'false');
    await expect(lines(page)).toHaveCount(0);
    // With the menu closed, the same click adds the product: the tile was under the overlay, not dead.
    await clickThrough(page, tile);
    await expect(lines(page)).toHaveCount(1);

    await openMenu(page);
    await page.keyboard.press('Escape');
    await expect(menu(page)).toHaveCount(0);
    await expect(page.getByTestId('cart-add-menu-overlay')).toHaveCount(0);
    await expect(lines(page)).toHaveCount(1);
  });
});

test.describe('at 390 × 844', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('in the phone cart a click on Checkout closes the "+" menu and does not start the tender', async ({ page }) => {
    await signIn(page);
    await addE2E1(page);
    await cartTab(page).click();
    await expect(lines(page)).toHaveCount(1);
    await openMenu(page);
    await clickThrough(page, page.getByTestId('cart-checkout'));
    await expect(menu(page)).toHaveCount(0);
    await expect(page.getByTestId('cart-add-menu-overlay')).toHaveCount(0);
    await expect(cartTab(page)).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('heading', { name: 'Checkout Order', exact: true })).toHaveCount(0);
    await expect(lines(page)).toHaveCount(1);
  });
});
