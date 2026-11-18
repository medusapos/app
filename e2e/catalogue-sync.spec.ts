import { expect } from '@playwright/test';
import { signIn, test } from './helpers';

// v2's catalogue sync arrow on the Sale status line: a tap syncs; a press and hold opens Sync and Clear and Refresh.
test.use({ viewport: { width: 1280, height: 800 } });

test('a tap syncs, a press and hold opens the menu, and Clear and Refresh refills the catalogue', async ({ page }) => {
  await signIn(page);
  const arrow = page.getByTestId('catalogue-sync');
  await expect(arrow).toBeVisible();

  await arrow.click();
  await expect(page.getByText(/Up to date · 5 products/)).toBeVisible();
  await expect(page.getByTestId('catalogue-clear-refresh')).toHaveCount(0);

  const box = (await arrow.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();
  await expect(page.getByRole('menuitem', { name: 'Sync' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Clear and Refresh' })).toBeVisible();

  await page.getByTestId('catalogue-clear-refresh').click();
  await expect(page.getByTestId('catalogue-clear-refresh')).toHaveCount(0);
  await expect(page.getByText(/Up to date · 5 products/)).toBeVisible();
  for (const n of [1, 2, 3, 4, 5]) await expect(page.getByTestId(`product-tile-E2E product ${n}`)).toBeVisible();
  await expect(page.getByTestId(/^product-tile-/)).toHaveCount(5);
});
