import { expect, type Page } from '@playwright/test';
import { addE2E1, cartLine, signIn, test } from './helpers';

// v2's hotkeys on the web (lib/shortcuts.ts): Alt+F, Alt+P, Alt+O and the help sheet behind `?` / Alt+/. No sale is
// completed here, so E2E-1's shared stock is untouched.
const sheet = (page: Page) => page.getByTestId('shortcuts-sheet');
const search = (page: Page) => page.getByPlaceholder('Search or scan barcode / SKU', { exact: true });

test.describe('at 1280 × 800', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('? opens the sheet and Escape closes it; Alt+/ toggles it', async ({ page }) => {
    await signIn(page);
    await page.keyboard.press('?');
    await expect(sheet(page)).toBeVisible();
    await expect(sheet(page).getByText('Keyboard shortcuts', { exact: true }).first()).toBeVisible();
    for (const id of ['search.focus', 'sale.new', 'checkout.open', 'cart.previous', 'cart.next', 'discount.open',
      'sale.void', 'orders.open', 'help.open', 'escape']) {
      await expect(page.getByTestId(`shortcuts-row-${id}`)).toBeVisible();
    }
    // An empty cart cannot check out.
    await expect(page.getByTestId('shortcuts-row-checkout.open')).toHaveAttribute('aria-disabled', 'true');
    await page.keyboard.press('Escape');
    await expect(sheet(page)).toHaveCount(0);
    await page.keyboard.press('Alt+Slash');
    await expect(sheet(page)).toBeVisible();
    await page.keyboard.press('Alt+Slash');
    await expect(sheet(page)).toHaveCount(0);
    // `?` typed into the search stays text.
    await search(page).click();
    await page.keyboard.press('?');
    await expect(search(page)).toHaveValue('?');
    await expect(sheet(page)).toHaveCount(0);
  });

  test('Alt+F focuses the catalogue search, even from another field', async ({ page }) => {
    await signIn(page);
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    const inSearch = () => page.evaluate(() => !!document.activeElement?.closest('[data-testid="catalogue-search"]'));
    expect(await inSearch()).toBe(false);
    await page.keyboard.press('Alt+KeyF');
    await expect.poll(inSearch).toBe(true);
    await expect(search(page)).toBeFocused();
    // From inside the cart's coupon field, which keeps its own keys (react-native-web's TextInput).
    await addE2E1(page);
    const coupon = page.getByLabel('Coupon code', { exact: true });
    await coupon.click();
    await expect(coupon).toBeFocused();
    await page.keyboard.press('Alt+KeyF');
    await expect(search(page)).toBeFocused();
    await expect(coupon).toHaveValue('');
  });

  test('Alt+← and Alt+→ step through the open sales', async ({ page }) => {
    await signIn(page);
    const tabs = page.getByTestId(/^open-sale-tab-.*-who$/);
    const checkout = page.getByTestId('cart-checkout');
    for (const quantity of [1, 2, 3]) {
      for (let count = 0; count < quantity; count++) await addE2E1(page);
      await expect(tabs).toHaveCount(quantity);
      await expect(checkout).toContainText((quantity * 2.5).toFixed(2));
      await search(page).blur();
      if (quantity < 3) {
        await page.keyboard.press('Alt+KeyN');
        await expect(page.getByTestId('cart-empty')).toBeVisible();
      }
    }
    for (const [key, total] of [['ArrowLeft', '5.00'], ['ArrowLeft', '2.50'], ['ArrowLeft', '7.50'], ['ArrowRight', '2.50']]) {
      await search(page).blur();
      await page.keyboard.press(`Alt+${key}`);
      await expect(checkout).toContainText(total);
    }
  });

  test('Alt+V opens the Void confirm and Alt+D the discount sheet', async ({ page }) => {
    await signIn(page);
    await page.keyboard.press('Alt+Slash');
    for (const id of ['sale.void', 'discount.open']) {
      await expect(page.getByTestId(`shortcuts-row-${id}`)).toHaveAttribute('aria-disabled', 'true');
    }
    await page.keyboard.press('Escape');
    await expect(sheet(page)).toHaveCount(0);
    await addE2E1(page);
    await search(page).blur();
    await page.keyboard.press('Alt+KeyV');
    await expect(page.getByTestId('cart-void-dialog')).toBeVisible();
    await page.getByTestId('cart-void-keep').click();
    await expect(page.getByTestId('cart-void-dialog')).toHaveCount(0);
    await expect(cartLine(page, 'E2E product 1')).toBeVisible();
    await search(page).blur();
    await page.keyboard.press('Alt+KeyD');
    await expect(page.getByTestId('cart-add-discount-sheet')).toBeVisible();
  });

  test('with one product added, Alt+P opens the tender; not under the Void confirm', async ({ page }) => {
    await signIn(page);
    await addE2E1(page);
    // The cart's ⋮ Void asks first: no chord may open payment under that confirm.
    await page.getByTestId('cart-foot-more').click();
    await page.getByTestId('cart-foot-menu').getByRole('menuitem', { name: 'Void', exact: true }).click();
    await expect(page.getByTestId('cart-void-dialog')).toBeVisible();
    await page.keyboard.press('Alt+KeyP');
    await expect(page.getByTestId('tender-pane')).toHaveCount(0);
    await page.getByTestId('cart-void-keep').click();
    await expect(page.getByTestId('cart-void-dialog')).toHaveCount(0);
    await page.keyboard.press('Alt+KeyP');
    await expect(page.getByTestId('tender-pane')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('tender-pane')).toHaveCount(0);
  });

  test('Alt+O goes to Orders, where the sheet greys Orders and Search', async ({ page }) => {
    await signIn(page);
    await page.keyboard.press('Alt+KeyO');
    await expect(page).toHaveURL(/\/orders$/);
    await expect(page.getByRole('main', { name: 'Orders' })).toBeVisible();
    // Orders does not offer Orders again.
    await page.keyboard.press('?');
    await expect(page.getByTestId('shortcuts-row-orders.open')).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByTestId('shortcuts-row-search.focus')).toHaveAttribute('aria-disabled', 'true');
    await page.getByTestId('shortcuts-sheet-close').click();
    await expect(sheet(page)).toHaveCount(0);
  });

  test('pressing a row in the sheet closes it and runs it', async ({ page }) => {
    await signIn(page);
    await addE2E1(page);
    await search(page).blur();
    await page.keyboard.press('?');
    await expect(page.getByTestId('shortcuts-row-checkout.open')).not.toHaveAttribute('aria-disabled', 'true');
    await page.getByTestId('shortcuts-row-checkout.open').click();
    await expect(sheet(page)).toHaveCount(0);
    await expect(page.getByTestId('tender-pane')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('tender-pane')).toHaveCount(0);
    // Back on the cart the search box has focus again; Alt+/ still opens the sheet from it, then a chord over the
    // open sheet closes it and runs.
    await page.keyboard.press('Alt+Slash');
    await expect(sheet(page)).toBeVisible();
    // TallyUI's Dialog leaves focus where it was, so take it off the search first.
    await search(page).blur();
    await expect(search(page)).not.toBeFocused();
    await page.keyboard.press('Alt+KeyF');
    await expect(sheet(page)).toHaveCount(0);
    await expect(search(page)).toBeFocused();
  });
});
