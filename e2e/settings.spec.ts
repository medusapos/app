import { expect, test, type Page } from '@playwright/test';
import { addE2E1, signIn } from './helpers';

// Settings → Scanner (ADR 0016): minChars gates the phone-cart wedge listener, and the test-scan
// field judges a scan the same way, against the currently saved settings.
test.use({ viewport: { width: 360, height: 740 } });

async function openSettings(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
}

async function setMinChars(page: Page, value: string) {
  await page.getByLabel('Minimum characters', { exact: true }).fill(value);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
}

async function openCart(page: Page) {
  await page.getByRole('button', { name: /^Open cart, /}).click();
  await expect(page.getByRole('heading', { name: 'Cart', exact: true })).toBeVisible();
}

test('a saved minChars gates the wedge scan, and the test-scan field reports its verdict', async ({ page }) => {
  await signIn(page);
  await addE2E1(page);

  await openSettings(page);
  await setMinChars(page, '6');
  await page.goBack();

  await openCart(page);
  await page.keyboard.type('E2E-2', { delay: 10 });
  await page.keyboard.press('Enter');
  await expect(page.getByText('E2E product 2', { exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: 'Products', exact: true }).click();
  await openSettings(page);
  await setMinChars(page, '3');
  const testField = page.getByLabel('Test scan here', { exact: true });
  await testField.pressSequentially('E2E-2', { delay: 10 });
  await testField.press('Enter');
  await expect(page.getByText('Counts as a scan', { exact: true })).toBeVisible();
  await page.goBack();

  await openCart(page);
  await page.keyboard.type('E2E-2', { delay: 10 });
  await page.keyboard.press('Enter');
  await expect(page.getByText('E2E product 2', { exact: true })).toBeVisible();
});

test('opening /settings directly by URL still lands back on Products', async ({ page }) => {
  await signIn(page);
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Products', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Products', exact: true })).toBeVisible();
});
