import { expect, test } from '@playwright/test';
import { adminToken, captureSales, ordersByClientId, sellBySku, signIn, stockBySku } from './helpers';

// TallyUI #146: RxDB 16.21.1's query cache could leave a sale inserted while the outbox's pending read was
// in flight out of that read for good, so it sat "Waiting to sync" until the app restarted. Here the
// second sale completes at the moment the first sale's send is let go. The race is a few microtasks
// wide, so this can't hit it on every run; apps/expo/tests/outbox.test.tsx holds the read to hit it
// deterministically.
test('two cash sales in quick succession both reach Medusa once, with no reload', async ({ page }) => {
  const token = await adminToken();
  const before = await stockBySku(token);
  const sales = captureSales(page);
  await signIn(page);
  let loads = 0;
  page.on('load', () => { loads++; });

  // The first sale's send is held until the second sale completes.
  let releaseFirst!: () => void;
  const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let held = false;
  await page.route('**/tally/v1/commands', async (route) => {
    if (!held) { held = true; await firstReleased; }
    await route.continue();
  });

  await sellBySku(page, ['E2E-1'], 'exact');
  await expect.poll(() => held).toBe(true);

  const search = page.getByPlaceholder('Search or scan barcode / SKU', { exact: true });
  await search.fill('E2E-1');
  await search.press('Enter');
  await expect(search).toHaveValue('');
  await page.getByRole('button', { name: 'Cash', exact: true }).click();
  const tender = page.getByText('Cash Tendered', { exact: true }).locator('..');
  const amount = tender.locator('input');
  await tender.locator('[tabindex="0"]').first().click();
  await amount.fill(await amount.inputValue());
  // No wait between the second sale's completion and the first sale's send.
  await Promise.all([page.getByRole('button', { name: 'Complete sale', exact: true }).click(), releaseFirst()]);
  await page.getByRole('button', { name: 'New sale', exact: true }).click();

  await expect(page.getByText('All sales synced', { exact: true })).toBeVisible();
  expect(loads).toBe(0);
  expect(sales.size).toBe(2);
  const orders = await ordersByClientId(token);
  for (const clientId of sales.keys()) {
    expect(orders.filter((order) => order.metadata.tally_client_id === clientId)).toHaveLength(1);
  }
  const after = await stockBySku(token);
  expect(after['E2E-1']).toBe(before['E2E-1'] - 2);
});
