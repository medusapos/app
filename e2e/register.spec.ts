import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { addE2E1, credentials, sellBySku, signIn } from './helpers';

// Registers, part A (ADR 0017): a fresh till binds Register 1, opens it with a float of 100.00, takes a cash sale
// the register counts, records a paid in and undoes it. Part B (ADR 0018): Close register counts the drawer with
// the tiles, closes under the threshold to the closure sheet, the open card prefilled and the last closure's
// figures; a second test counts €10.00 short, which needs a manager's login (refused offline first).
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
// RegisterCount's EUR faces (TallyUI's denominations), largest first, in cents.
const EUR_FACES = [50000, 20000, 10000, 5000, 2000, 1000, 500, 200, 100, 50, 20, 10, 5, 2, 1];

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
        // A long status stays on one line beside the pill, cut with an ellipsis (TallyUI #169).
        const search = page.getByPlaceholder('Search or scan barcode / SKU', { exact: true });
        await search.fill('E2E product');
        const status = page.getByTestId('catalogue-status-row').getByText(/^Up to date · 5 products · \d+ matching$/);
        await expect(status).toBeVisible();
        const [height, clipped] = await status.evaluate((el) => [el.getBoundingClientRect().height, el.scrollWidth > el.clientWidth]);
        expect([height < 24, clipped]).toEqual([true, true]);
        await shot(page, 'products-long');
        await search.fill('');
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

      // Part B (ADR 0018): count the drawer with the tiles, exactly what's expected, and close under the threshold.
      await panel.getByTestId('register-panel-close').click();
      await expect(panel).toHaveCount(0);
      await expect(page.getByTestId('register-bar-pill')).toHaveText('Counting');
      // On a phone the count opens the cart view itself, even with an empty cart.
      const count = page.getByTestId('register-count');
      await expect(count).toBeVisible();
      const counted = 100 + total;
      let rest = Math.round(counted * 100);
      for (const face of EUR_FACES) {
        for (; rest >= face; rest -= face) await count.getByTestId(`den-tile-${face}`).click();
      }
      await expect(count.getByTestId('count-amount')).toHaveValue(counted.toFixed(2));
      await expect(count.getByTestId('count-variance')).toContainText('Exact');
      await shot(page, 'count');
      await count.getByTestId('count-close').click();
      const closureSheet = page.getByTestId('closure-sheet');
      await expect(closureSheet.getByTestId('closure-number')).toHaveText('Closure #1');
      await expect(closureSheet.getByTestId('closure-counted-cash')).toHaveText(new RegExp(`^Counted ${money(counted).source.slice(1, -1)}$`));
      await expect(page.getByTestId('approval-dialog')).toHaveCount(0);
      await expect(page.getByTestId('closure-approved-by')).toHaveCount(0);
      await expect(closureSheet.getByTestId('closure-check')).toHaveCSS('opacity', '1');
      await shot(page, 'closure-under');
      await closureSheet.getByTestId('closure-done').click();
      await expect(closureSheet).toHaveCount(0);
      // Back to selling: the open card, prefilled with the last count.
      await expect(page.getByTestId('open-register-amount')).toHaveValue(counted.toFixed(2));
      await expect(page.getByTestId('register-bar-pill')).toHaveText('Register closed');
      await shot(page, 'open-after-close');
      // The last closure's figures, from the frozen closure.
      await page.getByRole('button', { name: 'Open register panel', exact: true }).click();
      const figures = page.getByTestId('last-closure');
      await expect(figures.getByRole('heading')).toHaveText('Last closure · Closure #1');
      await expect(figures.getByTestId('last-closure-sales')).toHaveText(money(total));
      await expect(figures.getByTestId('last-closure-float')).toHaveText(money(100));
      await expect(figures.getByTestId('last-closure-expected-cash')).toHaveText(money(counted));
      await expect(figures.getByTestId('last-closure-counted-cash')).toHaveText(money(counted));
      await expect(figures.getByTestId('last-closure-variance-cash')).toHaveText('Exact');
      await expect(figures.getByTestId('last-closure-approved-by')).toHaveCount(0);
      await shot(page, 'last-closure-under');
      await figures.getByTestId('last-closure-done').click();
      await expect(figures).toHaveCount(0);
    });

    test('over the threshold: the approval dialog, its offline refusal, then a manager login approves the close', async ({ page }) => {
      await signIn(page);
      await page.getByRole('button', { name: 'Open register panel', exact: true }).click();
      await page.getByTestId('register-panel').getByTestId('register-panel-close').click();
      const count = page.getByTestId('register-count');
      // €10.00 short of the €100.00 float: over the €5.00 threshold.
      await count.getByTestId('count-amount').fill('90.00');
      await count.getByTestId('count-close').click();
      const dialog = page.getByTestId('approval-dialog');
      await expect(dialog.getByRole('heading')).toHaveText('Manager approval');
      await expect(dialog.getByTestId('approval-context')).toHaveText("This count is over the threshold. A manager's admin login approves it.");
      await shot(page, 'count-over');

      // The sign-in can't reach the backend: connect or count again, with only Cancel.
      await page.route('**/auth/user/emailpass', (route) => route.abort('internetdisconnected'));
      await dialog.getByTestId('approval-email').fill(credentials.email);
      await dialog.getByTestId('approval-password').fill(credentials.password);
      await dialog.getByTestId('approval-approve').click();
      await expect(dialog.getByTestId('approval-offline')).toHaveText('Connect to approve, or count again.');
      await expect(dialog.getByRole('button')).toHaveText(['Cancel']);
      await shot(page, 'approve-offline');
      await dialog.getByTestId('approval-cancel').click();
      await expect(count.getByTestId('count-manager-line')).toHaveText('Approval was not granted. The count is unchanged.');
      await expect(count.getByTestId('count-amount')).toHaveValue('90.00');
      await page.unroute('**/auth/user/emailpass');

      // Self-approval: the e2e admin approves with their own login (ADR 0018).
      await count.getByTestId('count-close').click();
      await dialog.getByTestId('approval-email').fill(credentials.email);
      await dialog.getByTestId('approval-password').fill(credentials.password);
      await dialog.getByTestId('approval-approve').click();
      const sheet = page.getByTestId('closure-sheet');
      await expect(sheet.getByTestId('closure-number')).toHaveText('Closure #1');
      await expect(page.getByTestId('closure-approved-by')).toHaveText(/^Approved by \S/);
      const approvedBy = await page.getByTestId('closure-approved-by').textContent();
      await expect(sheet.getByTestId('closure-check')).toHaveCSS('opacity', '1');
      await shot(page, 'closure');
      await sheet.getByTestId('closure-done').click();
      await expect(page.getByTestId('open-register-amount')).toHaveValue('90.00');
      await page.getByRole('button', { name: 'Open register panel', exact: true }).click();
      const figures = page.getByTestId('last-closure');
      await expect(figures.getByTestId('last-closure-variance-cash')).toHaveText(/^Short €?\s?10[.,]00\s?€?$/);
      await expect(figures.getByTestId('last-closure-approved-by')).toHaveText(approvedBy!);
      await shot(page, 'last-closure');
      // The password was never put in the page's address or its storage.
      const kept = await page.evaluate(() => JSON.stringify({ href: location.href, local: { ...localStorage }, session: { ...sessionStorage } }));
      expect(kept).not.toContain(credentials.password);
    });
  });
}
