import { expect } from '@playwright/test';
import { test } from './helpers';

const products = /Up to date · \d[\d,.  ]* products/;
const timeout = process.env.E2E_BACKEND_URL !== undefined ? 5 * 60_000 : undefined;

test('one click on /demo reaches the POS with products', async ({ page }) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto('/demo');
  await expect(page.getByRole('heading', { name: 'Medusa POS demo store', exact: true })).toBeVisible();
  await expect(page.getByText('cashier@demo.medusapos.com · demo1234', { exact: true })).toBeVisible();
  await expect(page.getByText('manager@demo.medusapos.com · demo1234', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Enter the demo', exact: true }).click();
  await expect(page.getByText(products)).toBeVisible({ timeout });
  await expect(page.getByText('Set up this till', { exact: true })).not.toBeVisible();
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
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
