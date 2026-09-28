import { expect, test, type Page } from '@playwright/test';
import { addE2E1, discount, sellBySku, signIn } from './helpers';

// The sale screen on a phone (ADR 0009): below 600 px a cart bar opens the cart at full height, its lines and
// order discount scroll, and the totals and pay buttons stay pinned. Sells only E2E-1 and E2E-2.
test.use({ viewport: { width: 360, height: 740 } });

// The "Sign out" header action's bounding box lies within the 360 px viewport (job #71 follow-up).
async function expectSignOutInViewport(page: Page) {
  const box = (await page.getByRole('button', { name: 'Sign out', exact: true }).boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(360);
}

test('at 360 × 740 the lines scroll under pinned totals and pay, and the cart bar counts items', async ({ page }) => {
  await signIn(page);
  await expectSignOutInViewport(page);
  await addE2E1(page);
  await addE2E1(page);
  const bar = page.getByRole('button', { name: /^Open cart, / });
  await expect(bar).toHaveAccessibleName(/^Open cart, 2 items, /);
  const box = (await bar.boundingBox())!;
  // Inset mx-3 each side (12 px) so the bar reads as a button, not a status line (job #69 follow-up).
  expect([box.width, box.height >= 56]).toEqual([336, true]);
  await bar.click();
  await expect(page.getByRole('heading', { name: 'Cart', exact: true })).toBeVisible();
  await expectSignOutInViewport(page);
  await discount(page, 'line', 'Percent', '10');
  await discount(page, 'order', 'Amount', '0.50');
  const orderChip = page.getByRole('button', { name: /^Remove discount .*0\.50/ });
  await expect(orderChip).toBeVisible();
  await page.getByRole('button', { name: 'Products', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Products', exact: true })).toBeVisible();
  await expect(bar).toHaveAccessibleName(/^Open cart, 2 items, \D*3\.88$/);
  await bar.click();
  const total = page.getByText('Total', { exact: true }).locator('..');
  const cash = page.getByRole('button', { name: 'Cash', exact: true });
  const card = page.getByRole('button', { name: 'Card terminal', exact: true });
  for (const target of [page.getByText('E2E product 1', { exact: true }), total, cash, card]) await expect(target).toBeInViewport();
  const [cashBox, cardBox] = [(await cash.boundingBox())!, (await card.boundingBox())!];
  expect([cashBox.y === cardBox.y, cashBox.height >= 48]).toEqual([true, true]);
  await orderChip.scrollIntoViewIfNeeded();
  for (const target of [orderChip, total, cash]) await expect(target).toBeInViewport();
  await page.getByRole('button', { name: 'Products', exact: true }).click();
  await page.getByTestId('product-tile-E2E product 2').click();
  await expect(bar).toHaveAccessibleName(/^Open cart, 3 items, /);
  await expect(page.getByText('Cart · 3 items', { exact: true })).toBeVisible();
  await bar.click();
  // With the order discount form open the two lines overflow: the list scrolls under the pinned footer, not the page.
  await page.getByRole('button', { name: 'Order discount', exact: true }).click();
  const cancel = page.getByRole('button', { name: 'Cancel', exact: true });
  await cancel.scrollIntoViewIfNeeded();
  for (const target of [cancel, total, cash]) await expect(target).toBeInViewport();
  await expect(page.getByText('E2E product 1', { exact: true })).not.toBeInViewport();
  await cancel.click();
  expect(await sellBySku(page, [], 'exact')).toBeGreaterThan(3.88);
  await expect(page.getByRole('button', { name: 'Cart is empty', exact: true })).toBeVisible();
});

// ADR 0015 (#82 review): an automatic sign-out during a save that can't finish waits, with a note that fits at 360 px.
test('a sign-out requested during a stuck save waits, and its note fits beside Sign out at 360 px', async ({ page }) => {
  await signIn(page);
  await addE2E1(page);
  await page.getByRole('button', { name: /^Open cart, / }).click();
  await page.getByRole('button', { name: 'Cash', exact: true }).click();
  const tender = page.getByText('Cash Tendered', { exact: true }).locator('..');
  await tender.locator('[tabindex="0"]').first().click();
  // A stuck save: the order's insert waits before its write (an E2E debug hook; a dead storage worker would stop
  // the sale's register stamp first, ADR 0017).
  await page.evaluate(() => (window as unknown as { __medusaposHoldOrderInserts: () => void }).__medusaposHoldOrderInserts());
  await page.getByRole('button', { name: 'Complete sale', exact: true }).click();

  // The same request a 401 or a refused refresh makes.
  await page.evaluate(() => (window as unknown as { __medusaposReportUnauthorized: () => void }).__medusaposReportUnauthorized());
  const note = page.getByText('Signed out after this sale is saved', { exact: true });
  await expect(note).toBeVisible();
  await expectSignOutInViewport(page);
  const box = (await note.boundingBox())!;
  expect([box.x >= 0, box.x + box.width <= 360]).toEqual([true, true]);
  // Still signed in, on the sale's tender.
  await expect(page.getByRole('button', { name: 'Complete sale', exact: true })).toBeVisible();
  await expect(page).not.toHaveURL(/\/login/);

  // The save lands: the receipt shows, and the deferred sign-out waits for it to clear, then runs.
  await page.evaluate(() => (window as unknown as { __medusaposReleaseOrderInserts: () => void }).__medusaposReleaseOrderInserts());
  const newSale = page.getByRole('button', { name: 'New sale', exact: true });
  await expect(newSale).toBeVisible();
  await expect(page.getByText("You'll be signed out when you start a new sale.", { exact: true })).toBeVisible();
  await expect(page).not.toHaveURL(/\/login/);
  await newSale.click();
  await expect(page).toHaveURL(/\/login/);
});

// ADR 0009 amendment: a keyboard-wedge scan in the phone cart view adds the product (job "wedge scan").
test('a keyboard-wedge scan in the cart view adds a product, and an unknown code alerts without adding one', async ({ page }) => {
  await signIn(page);
  await addE2E1(page);
  await page.getByRole('button', { name: /^Open cart, / }).click();
  await expect(page.getByRole('heading', { name: 'Cart', exact: true })).toBeVisible();

  // A tapped Pressable keeps focus in Chromium and activates on Enter; the scan's Enter must not also press it
  // (review follow-up). Tap "+" (E2E-1 to quantity 2), then scan without clicking anything else.
  await page.getByRole('button', { name: 'Increase E2E product 1', exact: true }).click();
  await expect(page.getByText(/× 2$/)).toHaveCount(1);
  await page.keyboard.type('E2E-2', { delay: 10 });
  await page.keyboard.press('Enter');
  await expect(page.getByText('E2E product 2', { exact: true })).toBeVisible();
  await expect(page.getByText(/× 2$/)).toHaveCount(1);
  await expect(page.getByText(/× 1$/)).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Cart', exact: true })).toBeVisible();

  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.type('ZZZ-NOPE', { delay: 10 });
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert')).toHaveText('No product matches "ZZZ-NOPE"');
  await expect(page.getByText(/× 2$/)).toHaveCount(1);
  await expect(page.getByText(/× 1$/)).toHaveCount(1);

  await page.getByText('Discount', { exact: true }).first().click();
  await page.getByRole('button', { name: 'Amount', exact: true }).click();
  await page.getByLabel('Discount value', { exact: true }).pressSequentially('0.10', { delay: 10 });
  await page.getByLabel('Discount value', { exact: true }).press('Enter');
  await expect(page.getByText(/× 2$/)).toHaveCount(1);
  await expect(page.getByText(/× 1$/)).toHaveCount(1);

  expect(await sellBySku(page, [], 'exact')).toBeGreaterThan(0);
});
