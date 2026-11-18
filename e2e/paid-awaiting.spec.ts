import { expect } from '@playwright/test';
import { signIn, startTender, tenderCash, test } from './helpers';

// v2's paid screen leads a sale saved while the store is unreachable with "Awaiting store", until the outbox sends it.
test('an offline sale\'s paid screen says Awaiting store until the store has it', async ({ page, context }) => {
  test.setTimeout(5 * 60_000);
  await signIn(page);
  await context.setOffline(true);
  // E2E-2: other specs depend on E2E-1's stock.
  const search = page.getByPlaceholder('Search or scan barcode / SKU', { exact: true });
  await search.fill('E2E-2');
  await search.press('Enter');
  await expect(search).toHaveValue('');
  await startTender(page, 'cash');
  await tenderCash(page, 'exact');
  await page.getByRole('button', { name: 'Complete sale', exact: true }).click();
  await expect(page.getByTestId('paid-awaiting-status')).toHaveText('Awaiting store · Cash');
  await expect(page.getByTestId('paid-awaiting-figure')).toHaveText(/^Paid /);
  await context.setOffline(false);
  // As offline.spec waits for "Sales are up to date.": the outbox's next attempt after reconnecting.
  await expect(page.getByTestId('paid-awaiting')).toBeHidden({ timeout: 3 * 60_000 });
  await page.getByRole('button', { name: 'New sale', exact: true }).click();
});
