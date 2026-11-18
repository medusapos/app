import { expect } from '@playwright/test';
import { sellBySku, signIn, test } from './helpers';

// v2's header "● Offline" (docs D/pos/offline): the browser losing the network shows it at once, not after a pull
// fails, with the sales waiting to send; the network back, the header clears by itself. Only E2E-2: other specs count
// E2E-1 stock.
test('the Sale header shows Offline as soon as the network drops, with the sales to send', async ({ page, context }) => {
  await signIn(page);
  const upToDate = page.getByText('Sales are up to date.', { exact: true });
  const headerState = page.getByTestId('header-register-state');
  await expect(upToDate).toBeVisible();
  await expect(headerState).toBeHidden();

  await context.setOffline(true);
  // Within 5 s: this must not wait for a product pull to fail.
  await expect(headerState).toHaveText('Offline', { timeout: 5_000 });
  await sellBySku(page, ['E2E-2'], 'exact');
  await expect(headerState).toHaveText('Offline · 1 sale to send');

  await context.setOffline(false);
  await expect(headerState).toBeHidden({ timeout: 60_000 });
  await expect(upToDate).toBeVisible({ timeout: 60_000 });
});
