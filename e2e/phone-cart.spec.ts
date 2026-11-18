import { expect, type Page } from '@playwright/test';
import { addE2E1, cartLineQuantity, cartTab, closeStoreRegister, discount, productsTab, sellBySku, signIn, tenderCash, test } from './helpers';

// The sale screen on a phone (ADR 0009): below 600 px the Cart tab opens the cart at full height, its lines and
// order discount scroll, and the totals and pay buttons stay pinned. Sells only E2E-1 and E2E-2.
test.use({ viewport: { width: 360, height: 740 } });

// The account header action's bounding box lies within the 360 px viewport (job #71 follow-up).
async function expectAccountInViewport(page: Page) {
  const box = (await page.getByTestId('user-menu').boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(360);
}

test('the phone tender is titled Checkout Order and its close returns to the cart', async ({ page }) => {
  await signIn(page);
  await addE2E1(page);
  await cartTab(page).click();
  await page.getByTestId('cart-checkout').click();
  await expect(page.getByRole('heading', { name: 'Checkout Order', exact: true })).toBeVisible();
  await expect(page.getByTestId('frame-menu')).toHaveCount(0);
  await expect(page.getByTestId('user-menu')).toHaveCount(0);
  const close = page.getByTestId('tender-close');
  await expect(close).toBeInViewport();
  const box = (await close.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(360);
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
  await close.click();
  await expect(cartTab(page)).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('cart-checkout')).toBeVisible();
  await expect(page.getByTestId('frame-menu')).toBeVisible();
  await expect(page.getByTestId('user-menu')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Complete sale' })).toHaveCount(0);
});

test('at 360 px the header title truncates before a closed register state and the account stays in view', async ({ page }) => {
  await closeStoreRegister();
  await signIn(page, 'Europe', false);
  const state = page.getByTestId('header-register-state');
  await expect(state).toHaveText('Choose register');
  await state.click();
  await page.getByTestId('register-picker-row-register-1').click();
  await expect(state).toHaveText('Closed');
  const heading = page.getByRole('heading', { name: / · Register 1$/ });
  await expect(heading).toBeVisible();
  const title = (await heading.boundingBox())!;
  const stateBox = (await state.boundingBox())!;
  // The state's pl-3 is the gap, so the title must end before the state's box (1 px for subpixel rounding).
  expect(title.x + title.width).toBeLessThanOrEqual(stateBox.x + 1);
  await expectAccountInViewport(page);
});

test('at 360 × 740 the lines scroll under pinned totals and pay, and the Cart tab counts items', async ({ page }) => {
  await signIn(page);
  await expect(cartTab(page)).toHaveAccessibleName('Cart, New');
  await expect(page.getByTestId('phone-tab-cart-new')).toHaveText('New');
  await expectAccountInViewport(page);
  // v2's phone header names the store and register; an open register shows no register state.
  await expect(page.getByRole('heading', { name: / · Register 1$/ })).toBeVisible();
  await expect(page.getByTestId('header-register-state')).toHaveCount(0);
  await addE2E1(page);
  await expect(page.getByTestId('phone-tab-cart-new')).toHaveCount(0);
  await addE2E1(page);
  const cart = cartTab(page);
  await expect(cart).toHaveAccessibleName(/^Cart, 2 items$/);
  await expect(page.getByTestId('phone-tab-cart-count')).toHaveText('2');
  const box = (await page.getByTestId('phone-tab-bar').boundingBox())!;
  expect([box.x, box.width]).toEqual([0, 360]);
  expect((await cart.boundingBox())!.height).toBeGreaterThanOrEqual(56);
  await cart.click();
  await expect(cartTab(page)).toHaveAttribute('aria-selected', 'true');
  await expectAccountInViewport(page);
  await discount(page, 'line', 'Percent', '10');
  await discount(page, 'order', 'Amount', '0.50');
  const orderChip = page.getByRole('button', { name: /^Remove discount .*0\.50/ });
  await expect(orderChip).toBeVisible();
  await productsTab(page).click();
  await expect(productsTab(page)).toHaveAttribute('aria-selected', 'true');
  await expect(cart).toHaveAccessibleName(/^Cart, 2 items$/);
  await cart.click();
  // v2's foot: the total is on Checkout (56 px), which shares one row with the ⋮ (44 px).
  const checkout = page.getByTestId('cart-checkout');
  await expect(checkout).toContainText('3.88');
  const more = page.getByTestId('cart-foot-more');
  for (const target of [page.getByText('E2E product 1', { exact: true }), checkout, more]) await expect(target).toBeInViewport();
  const [checkoutBox, moreBox] = [(await checkout.boundingBox())!, (await more.boundingBox())!];
  const centreGap = Math.abs(checkoutBox.y + checkoutBox.height / 2 - (moreBox.y + moreBox.height / 2));
  expect([centreGap <= 1, checkoutBox.height >= 56, Math.round(moreBox.width), Math.round(moreBox.height)]).toEqual([true, true, 44, 44]);
  await orderChip.scrollIntoViewIfNeeded();
  for (const target of [orderChip, checkout]) await expect(target).toBeInViewport();
  await productsTab(page).click();
  await page.getByTestId('product-tile-E2E product 2').click();
  await expect(cart).toHaveAccessibleName(/^Cart, 3 items$/);
  await expect(page.getByTestId('phone-tab-cart-count')).toHaveText('3');
  await cart.click();
  // The order discount dialog's Cancel fits; closing it restores the pinned Checkout, which carries the total.
  await page.getByTestId('cart-add-menu').click();
  await page.getByRole('menuitem', { name: 'Add Discount', exact: true }).click();
  const cancel = page.getByRole('button', { name: 'Cancel', exact: true });
  await expect(cancel).toBeInViewport();
  await cancel.click();
  await expect(checkout).toBeInViewport();
  expect(await sellBySku(page, [], 'exact')).toBeGreaterThan(3.88);
  await expect(cart).toHaveAccessibleName('Cart, New');
});

// ADR 0015 (#82 review): an automatic sign-out during a save that can't finish waits, with a note that fits at 360 px.
test('a sign-out requested during a stuck save waits, and its note fits at 360 px and Sign out is out of reach', async ({ page }) => {
  await signIn(page);
  await addE2E1(page);
  await cartTab(page).click();
  await page.getByTestId('cart-checkout').click();
  await tenderCash(page, 'exact');
  // A stuck save: the order's insert waits before its write (an E2E debug hook; a dead storage worker would stop
  // the sale's register stamp first, ADR 0017).
  await page.evaluate(() => (window as unknown as { __medusaposHoldOrderInserts: () => void }).__medusaposHoldOrderInserts());
  await page.getByRole('button', { name: 'Complete sale', exact: true }).click();

  // The same request a 401 or a refused refresh makes.
  await page.evaluate(() => (window as unknown as { __medusaposReportUnauthorized: () => void }).__medusaposReportUnauthorized());
  const note = page.getByText('Signed out after this sale is saved', { exact: true });
  await expect(note).toBeVisible();
  const box = (await note.boundingBox())!;
  expect([box.x >= 0, box.x + box.width <= 360]).toEqual([true, true]);
  // Still signed in, on the sale's tender.
  await expect(page.getByRole('button', { name: 'Complete sale', exact: true })).toBeVisible();
  await expect(page).not.toHaveURL(/\/login/);

  // The phone tender header carries only the title and the close, as v2's, so Sign out is out of reach until the
  // sale is saved.
  await expect(page.getByTestId('user-menu')).toHaveCount(0);

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
  await cartTab(page).click();
  await expect(cartTab(page)).toHaveAttribute('aria-selected', 'true');

  // A tapped Pressable keeps focus in Chromium and activates on Enter; the scan's Enter must not also press it
  // (review follow-up). Set E2E-1 to quantity 2 in its quantity popover (TallyUI 3.19.0), which hands focus back to the
  // line's quantity trigger on Apply, then scan without clicking anything else.
  await page.getByRole('button', { name: 'Edit quantity of E2E product 1', exact: true }).click();
  await page.getByTestId('quantity-popover-keypad-key-2').click();
  await page.getByTestId('quantity-popover-apply').click();
  await expect(page.getByTestId('quantity-popover')).toHaveCount(0);
  await expect(cartLineQuantity(page, 'E2E product 1')).toHaveText('2');
  await page.keyboard.type('E2E-2', { delay: 10 });
  await page.keyboard.press('Enter');
  await expect(page.getByText('E2E product 2', { exact: true })).toBeVisible();
  await expect(page.getByTestId('quantity-popover')).toHaveCount(0);
  await expect(cartLineQuantity(page, 'E2E product 1')).toHaveText('2');
  await expect(cartLineQuantity(page, 'E2E product 2')).toHaveText('1');
  await expect(cartTab(page)).toHaveAttribute('aria-selected', 'true');

  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.type('ZZZ-NOPE', { delay: 10 });
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert')).toHaveText('No product matches "ZZZ-NOPE"');
  await expect(cartLineQuantity(page, 'E2E product 1')).toHaveText('2');
  await expect(cartLineQuantity(page, 'E2E product 2')).toHaveText('1');

  await page.getByRole('button', { name: 'Edit quantity of E2E product 1', exact: true }).click();
  await page.getByRole('button', { name: 'Discount E2E product 1', exact: true }).click();
  await page.getByRole('button', { name: 'Amount', exact: true }).click();
  await page.getByLabel('Discount value', { exact: true }).pressSequentially('0.10', { delay: 10 });
  await page.getByLabel('Discount value', { exact: true }).press('Enter');
  await expect(cartLineQuantity(page, 'E2E product 1')).toHaveText('2');
  await expect(cartLineQuantity(page, 'E2E product 2')).toHaveText('1');

  expect(await sellBySku(page, [], 'exact')).toBeGreaterThan(0);
});
