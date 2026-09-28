import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { addE2E1, sellBySku, signIn } from './helpers';

// Registers, part A (ADR 0017): a fresh till binds Register 1, opens it with a float of 100.00, takes a cash sale
// the register counts, records a paid in and undoes it, and Close register reaches the counting placeholder.
// Paying is refused until the register is open; the cart works throughout. Sells only E2E-1.
// Each state is attached as a screenshot; REGISTER_SHOTS_DIR also saves them there as <state>-<width>.png.

async function shot(page: Page, state: string) {
  const body = await page.screenshot();
  const name = `${state}-${page.viewportSize()!.width}.png`;
  await test.info().attach(name, { body, contentType: 'image/png' });
  if (process.env.REGISTER_SHOTS_DIR) writeFileSync(path.join(process.env.REGISTER_SHOTS_DIR, name), body);
}

// The cart's E2E-1 line (the catalogue tile shows the same name, so its Remove action identifies the line).
const cartLine = (page: Page) => page.getByRole('button', { name: 'Remove E2E product 1', exact: true });
const money = (amount: number) => new RegExp(`^€?\\s?${amount.toFixed(2).replace('.', '[.,]')}\\s?€?$`);

for (const viewport of [{ width: 1280, height: 800 }, { width: 360, height: 780 }]) {
  test.describe(`at ${viewport.width} × ${viewport.height}`, () => {
    test.use({ viewport });
    const phone = viewport.width < 600;
    // On a phone the register's picker and open card show in the cart view, which the cart bar opens.
    const openCart = async (page: Page) => { if (phone) await page.getByRole('button', { name: /^Open cart, / }).click(); };

    test('bind, open with a float, a cash sale, a paid in and its Undo, and Close register', async ({ page }) => {
      await signIn(page, 'Europe', false);
      await expect(page.getByTestId('register-bar-pill')).toHaveText('Choose a register');
      // On a phone the bar ends Catalogue's status line.
      if (phone) {
        await expect(page.getByTestId('catalogue-status-row').getByTestId('register-bar-pill')).toBeVisible();
        await shot(page, 'products');
      }
      await addE2E1(page);
      await openCart(page);
      await expect(page.getByTestId('register-picker')).toBeVisible();
      await expect(cartLine(page)).toBeVisible();
      await shot(page, 'picker');

      await page.getByTestId('register-picker-row-register-1').click();
      await expect(page.getByTestId('open-register-card')).toBeVisible();
      await expect(page.getByTestId('register-bar-pill')).toHaveText('Register closed');
      await page.getByRole('button', { name: 'Cash', exact: true }).click();
      await expect(page.getByRole('alert')).toHaveText('Open the register to take payment.');
      await expect(page.getByRole('button', { name: 'Complete sale', exact: true })).toHaveCount(0);
      await expect(page.getByTestId('open-register-card')).toBeInViewport();
      await shot(page, 'open-card');

      await page.getByTestId('open-register-amount').fill('100.00');
      await page.getByTestId('open-register-button').click();
      await expect(page.getByRole('button', { name: 'Open register panel', exact: true })).toBeVisible();
      await expect(page.getByTestId('open-register-card')).toHaveCount(0);
      await expect(page.getByRole('alert')).toHaveCount(0);
      await expect(page.getByTestId('register-bar-pill')).toHaveCount(0);
      await expect(cartLine(page)).toBeVisible();
      await shot(page, 'selling-bar');

      const total = await sellBySku(page, [], 'exact');
      expect(total).toBeGreaterThan(0);
      if (phone) {
        // Products with the register open: the short status line and "Register ›" share one row.
        await expect(page.getByTestId('catalogue-status-row').getByText(/^Up to date · 5 products$/)).toBeVisible();
        await expect(page.getByTestId('catalogue-status-row').getByRole('button', { name: 'Open register panel' })).toBeVisible();
        await shot(page, 'products-open');
      }
      await page.getByRole('button', { name: 'Open register panel', exact: true }).click();
      const panel = page.getByTestId('register-panel');
      await expect(panel.getByTestId('register-panel-sales-count')).toHaveText('1 sale this session');
      const expectedCash = panel.getByTestId('register-panel-expected').getByText(/\d/);
      await expect(expectedCash).toHaveText(money(100 + total));

      await panel.getByTestId('register-panel-paid-in').click();
      const sheet = page.getByTestId('movement-sheet');
      await sheet.getByTestId('movement-amount').fill('5.00');
      await sheet.getByTestId('movement-reason').fill('Change for the float');
      await shot(page, 'movement-sheet');
      await sheet.getByTestId('movement-confirm').click();
      await expect(sheet).toHaveCount(0);
      await expect(expectedCash).toHaveText(money(105 + total));
      await panel.getByTestId('register-panel-movements').click();
      const row = panel.getByText(/^Paid in · .*5[.,]00.* · Change for the float$/);
      await expect(row).toBeVisible();
      await shot(page, 'panel');

      await panel.getByRole('button', { name: 'Undo', exact: true }).click();
      await expect(row).toHaveCount(0);
      await expect(expectedCash).toHaveText(money(100 + total));

      await panel.getByTestId('register-panel-close').click();
      await expect(panel).toHaveCount(0);
      await expect(page.getByTestId('register-bar-pill')).toHaveText('Counting');
      if (phone) {
        await addE2E1(page);
        await openCart(page);
      }
      await expect(page.getByText('Counting arrives in the next update.', { exact: true })).toBeVisible();
      await shot(page, 'counting-fallback');
      await page.getByRole('button', { name: 'Back to selling', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Cash', exact: true })).toBeVisible();
      await expect(page.getByTestId('register-bar-pill')).toHaveCount(0);
    });
  });
}
