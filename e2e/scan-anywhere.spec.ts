import { expect } from '@playwright/test';
import { addE2E1, cartLine, cartLineQuantity, cartTab, openArea, productsTab, signIn, test } from './helpers';

// v2 scans anywhere in the POS (barcode-scanning, shot bs-1): on a non-phone window a keyboard-wedge scan adds with
// focus on a cart Pressable or on nothing, not only in the search box. Never sells, so E2E-1's shared stock is untouched.
test.use({ viewport: { width: 1024, height: 768 } });

test('a keyboard-wedge scan adds from anywhere on the wide sale screen, and an unknown code shows Barcode not found without adding', async ({ page }) => {
  await signIn(page);
  await addE2E1(page);

  // Set E2E-1 to quantity 2 in its quantity popover, which hands focus back to the line's quantity trigger on Apply;
  // the scan's Enter must not also press that trigger.
  await page.getByRole('button', { name: 'Edit quantity of E2E product 1', exact: true }).click();
  await page.getByTestId('quantity-popover-keypad-key-2').click();
  await page.getByTestId('quantity-popover-apply').click();
  await expect(page.getByTestId('quantity-popover')).toHaveCount(0);
  await expect(cartLineQuantity(page, 'E2E product 1')).toHaveText('2');
  await page.keyboard.type('E2E-2', { delay: 10 });
  await page.keyboard.press('Enter');
  await expect(cartLineQuantity(page, 'E2E product 2')).toHaveText('1');
  await expect(page.getByTestId('scan-toast')).toContainText('Added to cart');
  await expect(page.getByTestId('scan-toast')).toContainText('E2E product 2');
  await expect(cartLineQuantity(page, 'E2E product 1')).toHaveText('2');
  await expect(page.getByTestId('quantity-popover')).toHaveCount(0);

  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.type('ZZZ-NOPE', { delay: 10 });
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('scan-toast')).toContainText('Barcode not found');
  await expect(page.getByTestId('scan-toast')).toContainText('ZZZ-NOPE — not in this store');
  await expect(cartLineQuantity(page, 'E2E product 1')).toHaveText('2');
  await expect(cartLineQuantity(page, 'E2E product 2')).toHaveText('1');
});

// v2 puts a scan on Orders into the Orders search, never the cart. It never sells.
test('a keyboard-wedge scan on Orders fills Search Orders and adds nothing to the cart', async ({ page }) => {
  await signIn(page);
  await addE2E1(page);
  await expect(cartLineQuantity(page, 'E2E product 1')).toHaveText('1');

  await openArea(page, 'Orders');
  const search = page.getByTestId('orders-search');
  await expect(search).toBeVisible();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.type('E2E-2', { delay: 10 });
  await page.keyboard.press('Enter');
  await expect(search).toHaveValue('E2E-2');
  await test.info().attach('orders-scan-search.png', { body: await page.screenshot(), contentType: 'image/png' });

  await openArea(page, 'POS');
  await expect(cartLineQuantity(page, 'E2E product 1')).toHaveText('1');
  await expect(cartLine(page, 'E2E product 2')).toHaveCount(0);
});

// Row 02f.4: on a phone (below 600 px) the Products view takes a wedge scan as the Cart view does, and stays on
// Products. Never sells.
test.describe('phone Products view', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('a keyboard-wedge scan adds from the phone Products view after a tile tap, and an unknown code shows Barcode not found', async ({ page }) => {
    await signIn(page);
    await expect(productsTab(page)).toHaveAttribute('aria-selected', 'true');
    // The tapped tile keeps focus in Chromium and activates on Enter; the scan's Enter must not also press it.
    await page.getByTestId('product-tile-E2E product 1').click();
    await expect(cartTab(page)).toHaveAccessibleName(/^Cart, 1 item$/);
    await expect(productsTab(page)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.type('E2E-2', { delay: 10 });
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('scan-toast')).toContainText('Added to cart');
    await expect(page.getByTestId('scan-toast')).toContainText('E2E product 2');
    await expect(cartTab(page)).toHaveAccessibleName(/^Cart, 2 items$/);
    await expect(productsTab(page)).toHaveAttribute('aria-selected', 'true');

    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.type('ZZZ-NOPE', { delay: 10 });
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('scan-toast')).toContainText('Barcode not found');
    await expect(page.getByTestId('scan-toast')).toContainText('ZZZ-NOPE — not in this store');
    await expect(cartTab(page)).toHaveAccessibleName(/^Cart, 2 items$/);

    await cartTab(page).click();
    await expect(cartTab(page)).toHaveAttribute('aria-selected', 'true');
    await expect(cartLineQuantity(page, 'E2E product 1')).toHaveText('1');
    await expect(cartLineQuantity(page, 'E2E product 2')).toHaveText('1');
  });
});
