import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, type Page } from '@playwright/test';
import { addE2E1, adminToken, captureCommands, cartTotalRow, closeStoreRegister, credentials, inventoryLevel, nextStoreClosure, openStoreRegister, ordersByClientId, sellBySku, setInventoryLevel, signIn, storeRegister, submitStoreClosure, test, type PostedCommand } from './helpers';
import { E2E_RUN } from './ports';

const backend = process.env.E2E_BACKEND_URL ?? `http://localhost:${E2E_RUN.backendPort}`;
// The store's closure history row for `sessionId`'s closure (closure-history.ts), read with the e2e admin token.
async function storeClosure(sessionId: string): Promise<{ sessionId: string; number: number; approvalVerified: boolean } | undefined> {
  const response = await fetch(`${backend}/tally/v1/registers/register-1/closures`, { headers: { Authorization: `Bearer ${await adminToken()}` } });
  const { closures = [] } = await response.json() as { closures?: { sessionId: string; number: number; approvalVerified: boolean }[] };
  return closures.find((closure) => closure.sessionId === sessionId);
}

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
const cartLine = (page: Page) => page.getByRole('button', { name: 'Edit quantity of E2E product 1', exact: true });
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
      const opens = captureCommands<{ sessionId: string }>(page, 'register.session.open');
      const sales = captureCommands<{ sessionId: string }>(page);
      await closeStoreRegister();
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
      await page.getByTestId('cart-checkout').click();
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
      // Spec-42: the register sync reaches the store; the open is applied, for the session the sale was taken in.
      await expect.poll(() => [opens.map(({ status }) => status), sales.map(({ status }) => status)]).toEqual([['applied'], ['applied']]);
      expect(opens[0].payload.sessionId).toBe(sales[0].payload.sessionId);
      const closure = await nextStoreClosure();
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
      await expect(closureSheet.getByTestId('closure-number')).toHaveText(closure);
      await closureSheet.getByTestId('closure-print').click();
      await expect(page.frameLocator('#closure-print-frame').locator('h2')).toHaveText(`Z report · ${closure}`);
      await expect(closureSheet.getByTestId('closure-print')).toHaveText('Print the Z report');
      await expect(closureSheet.getByTestId('closure-print-error')).toHaveCount(0);
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
      await expect(figures.getByRole('heading')).toHaveText(`Last closure · ${closure}`);
      await expect(figures.getByTestId('last-closure-sales')).toHaveText(money(total));
      await expect(figures.getByTestId('last-closure-float')).toHaveText(money(100));
      await expect(figures.getByTestId('last-closure-expected-cash')).toHaveText(money(counted));
      await expect(figures.getByTestId('last-closure-counted-cash')).toHaveText(money(counted));
      await expect(figures.getByTestId('last-closure-variance-cash')).toHaveText('Exact');
      await expect(figures.getByTestId('last-closure-approved-by')).toHaveCount(0);
      await shot(page, 'last-closure-under');
      await figures.getByTestId('last-closure-done').click();
      await expect(figures).toHaveCount(0);
      // Over the whole session, its movements and close included, the open went out exactly once.
      expect(opens.map(({ status }) => status)).toEqual(['applied']);
    });

    test('a close whose closure write failed shows TallyUI\'s Finish closing card, which completes it with the stored count', async ({ page }) => {
      await signIn(page);
      const closure = await nextStoreClosure();
      await page.getByRole('button', { name: 'Open register panel', exact: true }).click();
      await page.getByTestId('register-panel').getByTestId('register-panel-close').click();
      const count = page.getByTestId('register-count');
      await count.getByTestId('count-amount').fill('100.00');
      // The session closes, then its closure write fails: as a restart mid-close leaves it (an e2e debug hook).
      await page.evaluate(() => (window as Window & { __medusaposFailNextClosureInsert?: () => void }).__medusaposFailNextClosureInsert!());
      await count.getByTestId('count-close').click();
      const finish = page.getByTestId('register-column-finish-close');
      await expect(finish).toBeVisible();
      await expect(page.getByTestId('open-register-card')).toHaveCount(0);
      await expect(page.getByTestId('closure-sheet')).toHaveCount(0);
      // TallyUI #175's pill; tapping it focuses the card's button.
      await expect(page.getByTestId('register-bar-pill')).toHaveText('Close not finished');
      await page.getByTestId('register-bar-pill').click();
      await expect(finish.getByTestId('register-column-finish-close-button')).toBeFocused();
      await shot(page, 'finish-close');
      await finish.getByTestId('register-column-finish-close-button').click();
      const sheet = page.getByTestId('closure-sheet');
      await expect(sheet.getByTestId('closure-number')).toHaveText(closure);
      await expect(sheet.getByTestId('closure-counted-cash')).toHaveText(/^Counted €?\s?100[.,]00\s?€?$/);
      await sheet.getByTestId('closure-done').click();
      await expect(page.getByTestId('open-register-amount')).toHaveValue('100.00');
      await expect(finish).toHaveCount(0);
    });

    test('over the threshold: the approval dialog, its offline refusal, then a manager login approves the close', async ({ page }) => {
      await signIn(page);
      const closure = await nextStoreClosure();
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
      // At contract 3 the approval goes to the store's route (ADR 0023).
      await page.route('**/tally/v1/register-approvals', (route) => route.abort('internetdisconnected'));
      await dialog.getByTestId('approval-email').fill(credentials.email);
      await dialog.getByTestId('approval-password').fill(credentials.password);
      await dialog.getByTestId('approval-approve').click();
      await expect(dialog.getByTestId('approval-offline')).toHaveText('Connect to approve, or count again.');
      await expect(dialog.getByRole('button')).toHaveText(['Cancel']);
      await shot(page, 'approve-offline');
      await dialog.getByTestId('approval-cancel').click();
      await expect(count.getByTestId('count-manager-line')).toHaveText('Approval was not granted. The count is unchanged.');
      await expect(count.getByTestId('count-amount')).toHaveValue('90.00');
      await page.unroute('**/tally/v1/register-approvals');

      // Self-approval: the e2e admin approves with their own login (ADR 0018).
      await count.getByTestId('count-close').click();
      await dialog.getByTestId('approval-email').fill(credentials.email);
      await dialog.getByTestId('approval-password').fill(credentials.password);
      await dialog.getByTestId('approval-approve').click();
      const sheet = page.getByTestId('closure-sheet');
      await expect(sheet.getByTestId('closure-number')).toHaveText(closure);
      // TallyUI's ClosureSheet shows the approver itself (#174).
      await expect(sheet.getByTestId('closure-approved-by')).toHaveText(/^Approved by \S/);
      const approvedBy = await sheet.getByTestId('closure-approved-by').textContent();
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

    // Counts €10.00 short and approves in the dialog as the e2e admin (`dialog`), from the panel's Close register.
    async function closeOverThreshold(page: Page) {
      await page.getByRole('button', { name: 'Open register panel', exact: true }).click();
      await page.getByTestId('register-panel').getByTestId('register-panel-close').click();
      const count = page.getByTestId('register-count');
      await count.getByTestId('count-amount').fill('90.00');
      await count.getByTestId('count-close').click();
      await approveInDialog(page);
    }
    async function approveInDialog(page: Page) {
      const dialog = page.getByTestId('approval-dialog');
      await dialog.getByTestId('approval-email').fill(credentials.email);
      await dialog.getByTestId('approval-password').fill(credentials.password);
      await dialog.getByTestId('approval-approve').click();
      await expect(dialog).toHaveCount(0);
    }

    test('over the threshold at contract 3: the store verifies the manager\'s approval', async ({ page }) => {
      await signIn(page);
      const { session } = await storeRegister();
      const approvals = captureCommands<unknown>(page, 'register.closure.submit');
      const route = page.waitForResponse((response) => response.url().endsWith('/tally/v1/register-approvals'));
      await closeOverThreshold(page);
      expect((await route).status()).toBe(200);
      await expect(page.getByTestId('closure-sheet').getByTestId('closure-number')).toHaveText(/^Closure #\d+$/);
      await expect.poll(() => approvals.map(({ status }) => status), { timeout: 30_000 }).toContain('applied');
      expect((await storeClosure(session!.id))?.approvalVerified).toBe(true);
    });

    test('a closure the store refuses for its approval: the card asks again, and the new approval is accepted', async ({ page }) => {
      await signIn(page);
      const { session } = await storeRegister();
      const submits = captureCommands<unknown>(page, 'register.closure.submit');
      // One well-formed answer with a proof the store never issued: the store refuses the closure.
      await page.route('**/tally/v1/register-approvals', (route) => route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ approval: 'bogus-proof', approvedBy: 'user_bogus', approvedByName: 'Nobody', expiresAt: new Date(Date.now() + 60_000).toISOString() }) }),
      { times: 1 });
      await closeOverThreshold(page);
      await page.getByTestId('closure-sheet').getByTestId('closure-done').click();
      await expect.poll(() => submits.map(({ code }) => code), { timeout: 30_000 }).toContain('register_approval_invalid');
      await page.unroute('**/tally/v1/register-approvals');

      await page.getByRole('button', { name: 'Open register panel', exact: true }).click();
      const card = page.getByTestId('register-panel').getByTestId('register-panel-reapproval');
      await expect(card).toBeVisible();
      await shot(page, 'reapproval-card');
      await card.getByTestId('register-panel-reapprove').click();
      await approveInDialog(page);
      await expect(card).toHaveCount(0);
      await expect.poll(async () => (await storeClosure(session!.id))?.approvalVerified, { timeout: 30_000 }).toBe(true);
    });

    // TallyUI #657 (#655): this till's closure submit is held while its close reaches the store, and another till's closure
    // takes its number there; the store refuses it register_closure_number_invalid, and the till renumbers it from the
    // refusal's counters and resends it, with no tap from the cashier.
    test('a closure the store refuses for its number is renumbered from the store\'s counters and accepted', async ({ page }) => {
      const opens = captureCommands<{ sessionId: string }>(page, 'register.session.open');
      const submits = captureCommands<{ closureId: string; number: number }>(page, 'register.closure.submit');
      await signIn(page);
      const sessionId = opens[0].payload.sessionId;
      const last = (await storeRegister()).counters!.lastClosureNumber;
      // A batch's closure submits are held: taken out of a batch with other commands, or the request kept unanswered.
      let release!: () => void;
      const released = new Promise<void>((resolve) => { release = resolve; });
      let holding = true;
      await page.route(`${backend}/tally/v1/commands`, async (route) => {
        const body = route.request().postDataJSON() as { commands: PostedCommand<unknown>[] };
        const rest = body.commands.filter(({ type }) => type !== 'register.closure.submit');
        if (!holding || rest.length === body.commands.length) return route.continue();
        if (rest.length) return route.continue({ postData: JSON.stringify({ ...body, commands: rest }) });
        await released;
        await route.continue().catch(() => {});
      });
      await page.getByRole('button', { name: 'Open register panel', exact: true }).click();
      await page.getByTestId('register-panel').getByTestId('register-panel-close').click();
      const count = page.getByTestId('register-count');
      await count.getByTestId('count-amount').fill('100.00');
      await count.getByTestId('count-close').click();
      const sheet = page.getByTestId('closure-sheet');
      await expect(sheet.getByTestId('closure-number')).toHaveText(`Closure #${last + 1}`);
      // This till's close is applied at the store, its closure is not; another till then opens, closes and submits #last+1.
      await expect.poll(async () => (await storeRegister()).session).toMatchObject({ id: sessionId, status: 'closed' });
      const counterSessionId = await openStoreRegister('Counter till');
      await closeStoreRegister();
      await submitStoreClosure(counterSessionId, last + 1);
      const answered = () => [...new Map(submits.filter(({ status }) => status).map((submit) => [submit.id, submit])).values()];
      expect(answered()).toEqual([]);
      holding = false;
      release();
      await expect.poll(() => answered().map(({ payload, status, code }) => [payload.number, status, code]), { timeout: 30_000 })
        .toEqual([[last + 1, 'rejected', 'register_closure_number_invalid'], [last + 2, 'applied', undefined]]);
      expect(new Set(answered().map(({ payload }) => payload.closureId)).size).toBe(1);
      expect((await storeRegister()).counters?.lastClosureNumber).toBe(last + 2);
      expect((await storeClosure(sessionId))?.number).toBe(last + 2);
      // The screen names the closure by its new number, and no refused register command is left there.
      await expect(sheet.getByTestId('closure-number')).toHaveText(`Closure #${last + 2}`);
      await sheet.getByTestId('closure-print').click();
      await expect(page.frameLocator('#closure-print-frame').locator('h2')).toHaveText(`Z report · Closure #${last + 2}`);
      await sheet.getByTestId('closure-done').click();
      await page.getByRole('button', { name: 'Open register panel', exact: true }).click();
      await expect(page.getByTestId('last-closure').getByRole('heading')).toHaveText(`Last closure · Closure #${last + 2}`);
      await expect(page.getByText(/refused|needs attention/)).toHaveCount(0);
      await expect(page.getByTestId('register-panel-reapproval')).toHaveCount(0);
      await shot(page, 'renumbered');
    });
  });
}

// ADR-078: another till holds Register 1, so this till's open is refused into the conflict card naming that till;
// Take over supersedes its session, and a cash sale is then paid on this till and reaches Medusa once.
test('Register 1 open on another till: the conflict card names it, Take over, then a cash sale reaches Medusa', async ({ page }) => {
  const token = await adminToken();
  const sales = captureCommands<{ clientOrderId: string; totalMinor: number }>(page);
  await closeStoreRegister();
  await openStoreRegister('Counter till');
  await signIn(page, 'Europe', false);
  await page.getByTestId('register-picker-row-register-1').click();
  await page.getByTestId('open-register-amount').fill('100.00');
  await page.getByTestId('open-register-button').click();
  const card = page.getByTestId('register-conflict-card');
  await expect(card).toContainText('Counter till');
  await card.getByTestId('register-conflict-take-over').click();
  await expect(card).toHaveCount(0);
  // The suite shares E2E-1 stock, so give back this sale's unit.
  const level = await inventoryLevel(token, 'E2E-1');
  try {
    const total = await sellBySku(page, ['E2E-1'], 'exact');
    await expect.poll(() => sales.map(({ status }) => status)).toEqual(['applied']);
    const orders = (await ordersByClientId(token)).filter(order => order.metadata.tally_client_id === sales[0].payload.clientOrderId);
    expect(orders).toHaveLength(1);
    expect(orders[0].total).toBe(total);
  } finally {
    await setInventoryLevel(token, level.inventoryItemId, level.locationId, level.stockedQuantity);
  }
});

// ADR-078, the losing side: another till takes over Register 1 from this one. This till's next register command, a paid in
// sent at contract 1, is refused register_session_superseded, since this till opened its session at contract 2 (#245).
test('Register 1 taken over by another till: this till\'s paid in is refused superseded, and it shows the register closed', async ({ page }) => {
  const opens = captureCommands<{ sessionId: string }>(page, 'register.session.open');
  const movements = captureCommands<{ sessionId: string }>(page, 'register.movement.record');
  await signIn(page);
  const sessionId = opens[0].payload.sessionId;
  const counterSessionId = await openStoreRegister('Counter till', 'register-1', sessionId);
  await page.getByRole('button', { name: 'Open register panel', exact: true }).click();
  await page.getByTestId('register-panel').getByTestId('register-panel-paid-in').click();
  const sheet = page.getByTestId('movement-sheet');
  await sheet.getByTestId('movement-amount').fill('5.00');
  await sheet.getByTestId('movement-reason').fill('Change for the float');
  await sheet.getByTestId('movement-confirm').click();
  await expect.poll(() => movements.map(({ status, code }) => [status, code])).toEqual([['rejected', 'register_session_superseded']]);
  expect(movements[0].payload.sessionId).toBe(sessionId);
  // TallyUI 3.8.0 has no superseded view: useRegisterSession's current session skips a superseded one, so RegisterColumn
  // shows OpenRegisterCard as for a closed register, and the bar's pill reads "Register closed".
  await expect(page.getByTestId('open-register-card')).toBeVisible();
  await expect(page.getByTestId('register-bar-pill')).toHaveText('Register closed');
  await addE2E1(page);
  await page.getByTestId('cart-checkout').click();
  await expect(page.getByRole('alert')).toHaveText('Open the register to take payment.');
  await expect(page.getByRole('button', { name: 'Complete sale', exact: true })).toHaveCount(0);
  await shot(page, 'superseded');
  // The store's register is the Counter till's session, still at its float: the paid in counted nowhere.
  expect((await storeRegister()).session).toMatchObject({ id: counterSessionId, status: 'open', expected: { cash: 10000 } });
});

// ADR-078 decision 3: a till that lost its local state opens Register 1 again under a new session id, and the store resumes
// its live session, because the open carries the same deviceId. TallyUI keeps that id in localStorage (getDeviceId,
// `medusapos.register_id`) and the register in the SQLite database, so a new browser context given only that key is
// this till with its database lost. Clearing the whole origin would mint a new device id: another till, not a resume.
test('a till that lost its local state opens Register 1 again and resumes its store session, then a cash sale reaches Medusa', async ({ page, browser, baseURL }) => {
  const token = await adminToken();
  const opens = captureCommands<{ sessionId: string }>(page, 'register.session.open');
  await signIn(page);
  const storeSessionId = opens[0].payload.sessionId;
  const deviceId = await page.evaluate(() => localStorage.getItem('medusapos.register_id'));
  expect(deviceId).toBeTruthy();
  await page.close();
  const context = await browser.newContext({ baseURL, storageState: { cookies: [],
    origins: [{ origin: new URL(baseURL!).origin, localStorage: [{ name: 'medusapos.register_id', value: deviceId! }] }] } });
  try {
    const till = await context.newPage();
    const reopens = captureCommands<{ sessionId: string }>(till, 'register.session.open');
    const sales = captureCommands<{ sessionId: string; clientOrderId: string }>(till);
    // Not signIn's openRegister, which closes the store's session first.
    await signIn(till, 'Europe', false);
    await till.getByTestId('register-picker-row-register-1').click();
    await till.getByTestId('open-register-amount').fill('100.00');
    await till.getByTestId('open-register-button').click();
    await expect.poll(() => reopens.map(({ status }) => status)).toEqual(['applied']);
    expect(reopens[0].payload.sessionId).not.toBe(storeSessionId);
    await expect(till.getByRole('button', { name: 'Open register panel', exact: true })).toBeVisible();
    await expect(till.getByTestId('register-conflict-card')).toHaveCount(0);
    await expect(till.getByTestId('open-register-card')).toHaveCount(0);
    expect((await storeRegister()).session).toMatchObject({ id: storeSessionId, status: 'open', salesCount: 0 });
    // The suite shares E2E-1 stock, so give back this sale's unit.
    const level = await inventoryLevel(token, 'E2E-1');
    try {
      const total = await sellBySku(till, ['E2E-1'], 'exact');
      await expect.poll(() => sales.map(({ status }) => status)).toEqual(['applied']);
      expect(sales[0].payload.sessionId).toBe(reopens[0].payload.sessionId);
      const orders = (await ordersByClientId(token)).filter(order => order.metadata.tally_client_id === sales[0].payload.clientOrderId);
      expect(orders).toHaveLength(1);
      expect(orders[0].total).toBe(total);
      // The sale, sent under the new local id, counts on the resumed store session through its alias.
      expect((await storeRegister()).session).toMatchObject({ id: storeSessionId, status: 'open', salesCount: 1 });
      await shot(till, 'resumed');
    } finally {
      await setInventoryLevel(token, level.inventoryItemId, level.locationId, level.stockedQuantity);
    }
  } finally {
    await context.close();
  }
});

// v2's cart foot (TallyUI 3.18.0): Checkout opens the tender through the register gate, and ⋮ → Void, asked first,
// empties a sale with lines and no payments without recording it.
test('with Register 1 open, Checkout opens the tender, and ⋮ Void asks first and then empties the cart', async ({ page }) => {
  const sales = captureCommands(page);
  await signIn(page);
  await addE2E1(page);
  await addE2E1(page);
  const checkout = page.getByTestId('cart-checkout');
  await expect(checkout).toHaveText(/^Checkout \D*5\.00$/);
  await checkout.click();
  await expect(page.getByTestId('tender-pane')).toBeVisible();
  await expect(page.getByTestId('tender-balance')).toHaveText(/5\.00$/);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByTestId('tender-pane')).toHaveCount(0);
  const voidSale = async () => {
    await page.getByTestId('cart-foot-more').click();
    await page.getByTestId('cart-foot-menu').getByRole('menuitem', { name: 'Void', exact: true }).click();
    await expect(page.getByRole('alertdialog')).toContainText('Void this sale?');
  };
  await voidSale();
  await page.getByTestId('cart-void-keep').click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(cartTotalRow(page, 'Total')).toHaveText(/Total\D*5\.00$/);
  await voidSale();
  await page.getByTestId('cart-void-confirm').click();
  await expect(page.getByTestId('cart-empty')).toBeVisible();
  await expect(checkout).toHaveCount(0); // the empty cart draws no foot (TallyUI 3.19.0)
  await expect(page.getByTestId('cart-foot-more')).toHaveCount(0);
  expect(sales).toEqual([]);
});
