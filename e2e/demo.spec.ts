import { expect } from '@playwright/test';
import { signIn, test } from './helpers';

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
  await page.getByRole('button', { name: 'Enter the demo', exact: true }).click();
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

test('a non-demo account does not see the demo banner', async ({ page }) => {
  await signIn(page);
  await expect(page.getByTestId('demo-banner')).toHaveCount(0);
});

test('demo page works at phone width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/demo');
  for (const name of ['Enter the demo', 'Enter as manager']) {
    const button = page.getByRole('button', { name, exact: true });
    await expect(button).toBeVisible();
    const box = await button.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  }
  await page.getByRole('button', { name: 'Enter as manager', exact: true }).click();
  await expect(page.getByText(products)).toBeVisible({ timeout });
});

test('sign-in screen links to the demo', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('link', { name: 'Try the demo', exact: true }).click();
  await expect(page).toHaveURL(/\/demo$/);
  await expect(page.getByRole('heading', { name: 'Medusa POS demo store', exact: true })).toBeVisible();
});
