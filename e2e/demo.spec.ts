import { expect } from '@playwright/test';
import { openRegister, signIn, test } from './helpers';

const products = /Up to date · \d[\d,.  ]* products/;
const timeout = process.env.E2E_BACKEND_URL !== undefined ? 5 * 60_000 : undefined;

test('one click on /demo reaches the POS with products', async ({ page }) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    (window as any).__opened = [];
    window.open = (u?: string | URL) => { (window as any).__opened.push(String(u)); return null; };
  });
  await page.goto('/demo');
  await expect(page.getByRole('heading', { name: 'Medusa POS demo store', exact: true })).toBeVisible();
  await expect(page.getByText('cashier@demo.medusapos.com · demo1234', { exact: true })).toBeVisible();
  await expect(page.getByText('manager@demo.medusapos.com · demo1234', { exact: true })).toBeVisible();
  await page.getByTestId('demo-enter-cashier').click();
  await expect(page.getByText(products)).toBeVisible({ timeout });
  await expect(page.getByText('Set up this till', { exact: true })).not.toBeVisible();
  await expect(page.getByTestId('demo-banner')).toBeVisible();
  await page.getByTestId('demo-banner-site').click();
  await page.getByTestId('demo-banner-quick-start').click();
  await page.getByTestId('demo-banner-github').click();
  expect(await page.evaluate(() => (window as any).__opened)).toEqual([
    'https://medusapos.com',
    'https://medusapos.com/docs/quick-start',
    'https://github.com/medusapos/app',
  ]);
  await page.getByTestId('demo-banner-dismiss').click();
  await expect(page.getByTestId('demo-banner')).toHaveCount(0);
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('signed-out demo Quick start opens the docs and keeps What to try visible', async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__opened = [];
    window.open = (u?: string | URL) => { (window as any).__opened.push(String(u)); return null; };
  });
  await page.goto('/demo');
  await page.getByTestId('demo-quick-start').click();
  expect(await page.evaluate(() => (window as any).__opened)).toEqual(['https://medusapos.com/docs/quick-start']);
  for (const item of [
    'Ring up a sale and take cash or card',
    'Split a payment: part card, the rest cash (Split payment at checkout)',
    'Attach a customer to a sale: search one, or add a new one',
    'Park a sale, then resume it from Parked sales',
    "Change a line's price in the cart",
    'Add a fee, shipping or a custom item to a sale (Add charge in the cart)',
    'Close the register with a cash count',
  ]) await expect(page.getByText(`• ${item}`, { exact: true })).toBeVisible();
});

test('signed in as the demo cashier, each What to try action has its control', async ({ page }) => {
  await page.goto('/demo');
  await page.getByTestId('demo-enter-cashier').click();
  await expect(page.getByText(products)).toBeVisible({ timeout });
  await openRegister(page);
  await expect(page.getByTestId(/^product-tile-/).first()).toBeVisible();
  await page.getByTestId(/^product-tile-/).first().click();
  await expect(page.getByTestId('cart-footer')).toBeVisible();
  await expect(page.getByTestId('register-bar-open-panel')).toBeVisible();
  await page.getByTestId('register-bar-open-panel').click();
  await expect(page.getByTestId('register-panel-close')).toBeVisible();
  await page.getByTestId('register-panel-dismiss').click();
  await page.getByRole('button', { name: /^Customer: /, exact: true }).click();
  await expect(page.getByTestId('customer-dialog')).toBeVisible();
  await expect(page.getByTestId('customer-dialog').getByTestId('customer-picker-search')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('customer-dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Add charge', exact: true }).click();
  await expect(page.getByTestId('charge-form')).toBeVisible();
  // The one line's price opens v2's price keypad popover.
  const checkoutBefore = await page.getByTestId('cart-checkout').boundingBox();
  await page.getByTestId('price-popover-trigger').click();
  await expect(page.getByTestId('price-popover')).toBeVisible();
  await expect(page.getByTestId('price-popover-apply')).toBeVisible();
  // It floats under its trigger and the app keeps its height: compiled from src, TallyUI's
  // use-relative-position.web.ts stub (returns {}) put it in the page flow (metro.config.js redirects it).
  const triggerBox = (await page.getByTestId('price-popover-trigger').boundingBox())!;
  expect(await page.getByTestId('price-popover').evaluate((el) => getComputedStyle(el).position)).toBe('absolute');
  await expect.poll(async () => (await page.getByTestId('price-popover').boundingBox())?.y).toBeGreaterThanOrEqual(triggerBox.y + triggerBox.height);
  expect(await page.getByTestId('cart-checkout').boundingBox()).toEqual(checkoutBefore);
  await page.getByTestId('price-popover-cancel').click();
  await expect(page.getByTestId('price-popover')).toHaveCount(0);
  await page.getByRole('button', { name: 'Parked sales', exact: true }).click();
  await expect(page.getByTestId('parked-sales-park')).toBeVisible();
  await page.getByTestId('parked-sales-dismiss').click();
  await page.getByTestId('cart-checkout').click();
  await expect(page.getByTestId('tender-method-external')).toBeVisible();
  await expect(page.getByTestId('tender-method-cash')).toBeVisible();
  await expect(page.getByTestId('tender-take')).toBeVisible();
});

test('a non-demo account does not see the demo banner', async ({ page }) => {
  await signIn(page);
  await expect(page.getByTestId('demo-banner')).toHaveCount(0);
});

test('demo page works at phone width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/demo');
  for (const [testID, label] of [['demo-enter-cashier', 'Enter the demo'], ['demo-enter-manager', 'Enter as manager']]) {
    const button = page.getByTestId(testID);
    await expect(button).toBeVisible();
    await expect(button).toHaveText(label);
    const box = await button.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  }
  await page.getByTestId('demo-enter-manager').click();
  await expect(page.getByText(products)).toBeVisible({ timeout });
});

test('sign-in screen links to the demo', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('link', { name: 'Try the demo', exact: true }).click();
  await expect(page).toHaveURL(/\/demo$/);
  await expect(page.getByRole('heading', { name: 'Medusa POS demo store', exact: true })).toBeVisible();
});
