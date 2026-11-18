import { expect } from '@playwright/test';
import { addE2E1, cartLineQuantity, signIn, test } from './helpers';

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
