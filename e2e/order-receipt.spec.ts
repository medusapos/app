import { expect } from '@playwright/test';
import { openArea, sellBySku, signIn, test } from './helpers';

// The Orders sheet's Receipt (DEMO-PARITY row 10.3): v2's reprint of a stored sale, through TallyUI's Receipt and its
// Print receipt, printing only the receipt. The sale's command is aborted, so it stays on the till and store stock is
// untouched.
test.use({ viewport: { width: 1280, height: 800 } });

test('Receipt reprints the sale from its order detail, and a print shows only the receipt', async ({ page }) => {
  await page.addInitScript(() => {
    const counted = window as Window & { __prints?: number };
    counted.__prints = 0;
    window.print = () => { counted.__prints! += 1; };
  });
  await signIn(page);
  await page.route('**/tally/v1/commands', route => route.abort());
  await sellBySku(page, ['E2E-2'], 'exact');
  await openArea(page, 'Orders');
  await page.getByRole('button', { name: /^Open order / }).first().click();
  const sheet = page.getByTestId('order-detail-sheet');
  await sheet.getByTestId('order-detail-receipt').click();

  const receipt = page.getByTestId('order-detail-receipt-view');
  await expect(receipt.getByTestId('receipt-order')).toHaveText(/^Order /);
  const total = receipt.getByLabel(/^Total: /);
  await expect(total).toBeVisible();
  await receipt.getByRole('button', { name: 'Print receipt', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as Window & { __prints?: number }).__prints)).toBe(1);

  // The open dialog hides the screen behind it from label queries, so the search is found by its placeholder.
  const search = page.getByPlaceholder('Search Orders', { exact: true });
  await expect(search).toBeVisible();
  await page.emulateMedia({ media: 'print' });
  await expect(total).toBeVisible();
  await expect(search).toBeHidden();
  // No layout box: the screen behind the reprint collapses on the printed page, not just turns invisible.
  expect(await search.boundingBox()).toBeNull();
  expect(await receipt.boundingBox()).toMatchObject({ x: 0, y: 0 });
  await expect(receipt.getByRole('button', { name: 'Print receipt', exact: true })).toBeHidden();

  await page.emulateMedia({ media: 'screen' });
  await receipt.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(sheet.getByTestId('order-detail')).toBeVisible();
  await expect(receipt).toHaveCount(0);
});
