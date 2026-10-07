import { expect, type Page } from '@playwright/test';
import { addE2E1, captureCommands, closeStoreRegister, openRegister, refusedStoreOpen, signIn, test } from './helpers';

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

// The same minChars is the Products search's minCodeLength (TallyUI #148): below it, Enter does no code lookup.
test('a saved minChars gates Enter in the Products search: a shorter code stays a search', async ({ page }) => {
  await signIn(page);
  const search = page.getByPlaceholder('Search or scan barcode / SKU', { exact: true });

  await openSettings(page);
  await setMinChars(page, '6');
  await page.goBack();
  await search.fill('E2E-2');
  await search.press('Enter');
  await expect(search).toHaveValue('E2E-2');
  await expect(page.getByRole('button', { name: 'Cart is empty', exact: true })).toBeVisible();

  await openSettings(page);
  await setMinChars(page, '3');
  await page.goBack();
  await search.fill('E2E-2');
  await search.press('Enter');
  await expect(search).toHaveValue('');
  await expect(page.getByRole('button', { name: /^Open cart, 1 item, / })).toBeVisible();
});

// Settings → Register (ADR 0016): the till name is the deviceName of this till's register v2 opens (ADR-078), so another
// till that finds Register 1 open is told "Front counter", not the platform label.
test('a till named in Settings opens Register 1 under that name at the store', async ({ page }) => {
  const opens = captureCommands<{ deviceName?: string }>(page, 'register.session.open');
  await signIn(page, 'Europe', false);
  await openSettings(page);
  const tillName = page.getByLabel('Till name', { exact: true });
  await tillName.fill('Front counter');
  await page.getByRole('button', { name: 'Save till name', exact: true }).click();
  await page.goBack();
  try {
    await openRegister(page);
    expect(opens.map(({ payload }) => payload.deviceName)).toEqual(['Front counter']);
    expect(await refusedStoreOpen()).toMatchObject({ deviceName: 'Front counter' });

    // An empty name goes back to the platform label.
    await openSettings(page);
    await expect(tillName).toHaveValue('Front counter');
    await tillName.fill('');
    await page.getByRole('button', { name: 'Save till name', exact: true }).click();
    await page.reload();
    await expect(tillName).toHaveValue('');
  } finally {
    await closeStoreRegister();
  }
});

// "‹ Products" goes back to the Products screen under Settings: a replace mounted a second, empty one over it,
// hiding the sale in progress (and any pending save) behind a fresh cart.
test('"‹ Products" from Settings returns to the same sale, with one Products screen mounted', async ({ page }) => {
  await signIn(page);
  await addE2E1(page);
  const cartBar = page.getByRole('button', { name: /^Open cart, 1 item, / });
  await expect(cartBar).toBeVisible();

  await openSettings(page);
  await page.getByRole('button', { name: 'Products', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Products', exact: true })).toBeVisible();
  await expect(cartBar).toBeVisible();
  // Hidden stack screens stay in the DOM, so this counts every mounted Products screen.
  await expect(page.getByPlaceholder('Search or scan barcode / SKU', { exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Cart is empty', exact: true })).toHaveCount(0);
});

test('opening /settings directly by URL still lands back on Products', async ({ page }) => {
  await signIn(page);
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Products', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Products', exact: true })).toBeVisible();
});
