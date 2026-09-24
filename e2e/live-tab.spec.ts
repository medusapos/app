import { expect, test } from '@playwright/test';
import { sellBySku, signIn } from './helpers';

const SEARCH_PLACEHOLDER = 'Search or scan barcode / SKU';

test('a second tab takes over, and "Use here" reclaims it', async ({ page, context }) => {
  await signIn(page);

  const pageB = await context.newPage();
  await pageB.goto('/');
  await expect(pageB.getByText('Up to date · 5 products')).toBeVisible();

  await expect(page.getByText('MedusaPOS is open in another tab')).toBeVisible();
  // LiveTabScreen's Pressable renders with no explicit accessibility role.
  await expect(page.getByText('Use here', { exact: true })).toBeVisible();
  await expect(page.getByPlaceholder(SEARCH_PLACEHOLDER, { exact: true })).toHaveCount(0);

  await page.getByText('Use here', { exact: true }).click();
  await expect(page.getByText('Up to date · 5 products')).toBeVisible();
  await expect(pageB.getByText('MedusaPOS is open in another tab')).toBeVisible();
});

test('a payment in flight defers the hand-over up to 10 s', async ({ page, context }) => {
  await signIn(page);
  const search = page.getByPlaceholder(SEARCH_PLACEHOLDER, { exact: true });
  await search.fill('E2E-1');
  await search.press('Enter');
  await page.getByRole('button', { name: 'Cash', exact: true }).click();
  await expect(page.getByText('Cash Tendered', { exact: true })).toBeVisible();

  const openedAt = Date.now();
  const pageB = await context.newPage();
  await pageB.goto('/');
  await expect(pageB.getByText('Opening MedusaPOS…')).toBeVisible();
  // TallyUI's defer loop counts 100 ms sleeps rather than elapsed time, so
  // Chromium's background-tab timer throttling stretches a backgrounded live
  // tab's 10 s deferral; this test keeps the live tab in front to prove the
  // 10 s cap itself, and the stretch is reported to TallyUI.
  await page.bringToFront();

  await page.waitForTimeout(5000);
  await expect(page.getByText('Cash Tendered', { exact: true })).toBeVisible();

  await expect(page.getByText('MedusaPOS is open in another tab')).toBeVisible({ timeout: 15_000 });
  const parkedAfterMs = Date.now() - openedAt;
  expect(parkedAfterMs).toBeGreaterThanOrEqual(9000);
  expect(parkedAfterMs).toBeLessThanOrEqual(15_000);

  await expect(pageB.getByText('Up to date · 5 products')).toBeVisible();
  // No sale is completed: the tender stays open on the parked tab's own (now hidden) state.
});

test('closing the live tab makes the waiting tab live', async ({ page, context }) => {
  await signIn(page);
  const search = page.getByPlaceholder(SEARCH_PLACEHOLDER, { exact: true });
  await search.fill('E2E-1');
  await search.press('Enter');
  await page.getByRole('button', { name: 'Cash', exact: true }).click();
  await expect(page.getByText('Cash Tendered', { exact: true })).toBeVisible();

  const pageB = await context.newPage();
  await pageB.goto('/');
  await expect(pageB.getByText('Opening MedusaPOS…')).toBeVisible();

  await page.close();
  await expect(pageB.getByText('Up to date · 5 products')).toBeVisible({ timeout: 5000 });
});

test('pageshow after pagehide re-opens both databases', async ({ page }) => {
  await signIn(page);

  await page.evaluate(() => { window.dispatchEvent(new Event('pagehide')); });
  await expect(page.getByText('MedusaPOS is open in another tab')).toBeVisible();

  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await expect(page.getByText('Up to date · 5 products')).toBeVisible();

  const backend = process.env.E2E_BACKEND_URL ?? 'http://localhost:9100';
  const saleApplied = page.waitForResponse(async response => {
    if (response.request().method() !== 'POST' || response.url() !== `${backend}/tally/v1/commands`) return false;
    const body = await response.json();
    return (body.results ?? []).some((result: { status: string }) => result.status === 'applied');
  });
  await sellBySku(page, ['E2E-1'], 'exact');
  await saleApplied;
  await expect(page.getByLabel('Sync status', { exact: true })).toHaveText('All sales synced');
});
