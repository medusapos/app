import { expect, test } from '@playwright/test';
import { addE2E1, discount, sellBySku, signIn } from './helpers';

// The sale screen on a phone (ADR 0009): below 600 px a cart bar opens the cart at full height, its lines and
// order discount scroll, and the totals and pay buttons stay pinned. Sells only E2E-1 and E2E-2.
test.use({ viewport: { width: 360, height: 740 } });

test('at 360 × 740 the lines scroll under pinned totals and pay, and the cart bar counts items', async ({ page }) => {
  await signIn(page);
  await addE2E1(page);
  await addE2E1(page);
  const bar = page.getByRole('button', { name: /^Open cart, / });
  await expect(bar).toHaveAccessibleName(/^Open cart, 2 items, /);
  const box = (await bar.boundingBox())!;
  expect([box.width, box.height >= 56]).toEqual([360, true]);
  await bar.click();
  await discount(page, 'line', 'Percent', '10');
  await discount(page, 'order', 'Amount', '0.50');
  const orderChip = page.getByRole('button', { name: /^Remove discount .*0\.50/ });
  await expect(orderChip).toBeVisible();
  await page.getByRole('button', { name: 'Products', exact: true }).click();
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
