import { expect, type Page } from '@playwright/test';
import { addE2E1, adminToken, captureCommands, cartLine, cartTab, discount, ordersByClientId, productsTab, sellBySku, signIn, test } from './helpers';
import { appliedResponse } from './helpers';

type Sale = { clientOrderId: string; totalMinor: number;
  lines: { quantity: number; unitPriceMinor: number; discountMinor?: number }[] };
// Each open sale's name in the strip: the blank cart is the "+" tab, so with one sale parked there is one.
const saleTabs = (page: Page) => page.getByTestId(/^open-sale-tab-.*-who$/);

test('park a sale, sell another, resume the first and complete it: both orders reach Medusa once at the till\'s figures', async ({ page }) => {
  const token = await adminToken();
  const commands = captureCommands<Sale>(page);
  await signIn(page);
  await addE2E1(page);
  await addE2E1(page);
  await page.getByTestId('new-sale-tab').click();
  await expect(saleTabs(page)).toHaveCount(1);
  await expect(page.getByTestId('cart-empty')).toBeVisible();
  expect(commands).toHaveLength(0);
  await page.reload();
  await expect(saleTabs(page)).toHaveCount(1);
  const secondApplied = appliedResponse(page);
  expect(await sellBySku(page, ['E2E-1'], 'exact')).toBe(2.5);
  const second = (await (await secondApplied).json()).results;
  await expect(saleTabs(page)).toHaveCount(1);
  await saleTabs(page).click();
  await expect(page.getByTestId('cart-checkout')).toContainText('5.00');
  await expect(page.getByTestId('open-orders-count')).toHaveCount(0);
  const firstApplied = appliedResponse(page);
  expect(await sellBySku(page, [], 'exact')).toBe(5);
  const first = (await (await firstApplied).json()).results;
  await page.reload();
  await expect(page.getByText('Sales are up to date.', { exact: true })).toBeVisible();
  expect(commands).toHaveLength(2);
  expect(new Set(commands.map(({ payload }) => payload.clientOrderId)).size).toBe(2);
  const orders = await ordersByClientId(token);
  for (const [index, totalMinor] of [250, 500].entries()) {
    const { id, payload } = commands[index];
    expect(payload.totalMinor).toBe(totalMinor);
    expect(payload.lines).toEqual([expect.objectContaining({ unitPriceMinor: 200, quantity: index + 1 })]);
    const result = [...second, ...first].filter((entry: { id: string }) => entry.id === id);
    expect(result).toEqual([expect.objectContaining({ status: 'applied', serverRefs: expect.objectContaining({ totalMinor }) })]);
    expect(result[0].warnings).toBeUndefined();
    const matching = orders.filter((order) => order.metadata.tally_client_id === payload.clientOrderId);
    expect(matching).toHaveLength(1);
    expect(Math.round(matching[0].total * 100)).toBe(totalMinor);
  }
});

test('an edited unit price settles in Medusa at the till\'s total with no warnings', async ({ page }) => {
  const token = await adminToken();
  const commands = captureCommands<Sale>(page);
  await signIn(page);
  await addE2E1(page);
  await addE2E1(page);
  await discount(page, 'line', 'Percent', '10');
  // v2's price popover: tap the line's price, key the new one in, Apply.
  await cartLine(page, 'E2E product 1').getByTestId('price-popover-trigger').click();
  for (const key of ['3', 'decimal', '2', '0']) await page.getByTestId(`price-popover-keypad-key-${key}`).click();
  await page.getByTestId('price-popover-apply').click();
  await expect(page.getByTestId('cart-checkout')).toContainText('7.20');
  const applied = appliedResponse(page);
  expect(await sellBySku(page, [], 'exact')).toBe(7.2);
  const { results } = await (await applied).json();
  await page.reload();
  await expect(page.getByText('Sales are up to date.', { exact: true })).toBeVisible();
  expect(commands).toHaveLength(1);
  const [{ id, payload }] = commands;
  expect(payload.totalMinor).toBe(720);
  expect(payload.lines).toEqual([expect.objectContaining({ unitPriceMinor: 320, quantity: 2, discountMinor: 64 })]);
  const result = results.find((entry: { id: string }) => entry.id === id);
  expect(result).toMatchObject({ status: 'applied', serverRefs: { totalMinor: 720 } });
  expect(result.warnings).toBeUndefined();
  const orders = (await ordersByClientId(token)).filter((order) => order.metadata.tally_client_id === payload.clientOrderId);
  expect(orders).toHaveLength(1);
  expect(Math.round(orders[0].total * 100)).toBe(720);
});

// v2's Open orders (row 08.4): the count shows at the strip's start only once the tabs overflow it; it opens the list in
// the cart's place, and a row switches to its sale. Adds E2E-1 to carts only (no stock moves) and completes no sale.
for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  test.describe(`at ${viewport.width} × ${viewport.height}`, () => {
    test.use({ viewport });
    const phone = viewport.width < 600;
    // On a phone the cart, and so the strip, shows in the cart view, which the Cart tab opens (order-note.spec.ts's openCart).
    const openCart = async (page: Page) => { if (phone) await cartTab(page).click(); };
    const overflowing = (page: Page) => page.getByTestId('open-sale-tabs').getByRole('tablist')
      .evaluate((el) => el.scrollWidth > el.clientWidth + 1);

    test('with more open sales than the strip fits, the count opens Open orders and a row switches to that sale', async ({ page }) => {
      await signIn(page);
      const count = page.getByTestId('open-orders-count');
      let open = 0;
      let over = false;
      for (let round = 1; round <= 10 && !over; round++) {
        if (phone && round > 1) await productsTab(page).click();
        await addE2E1(page);
        await openCart(page);
        await page.getByTestId('new-sale-tab').click();
        await expect(page.getByTestId('cart-empty')).toBeVisible();
        open = round;
        await expect(saleTabs(page)).toHaveCount(open);
        if (!phone && open === 2) await expect(count).toHaveCount(0);
        over = await overflowing(page);
        // The count follows the strip: hidden while every tab fits, shown once they overflow.
        await expect(count).toHaveCount(over ? 1 : 0);
      }
      expect(over, 'the strip overflows within 10 open sales').toBe(true);
      await expect(count).toBeVisible();
      await count.click();
      const list = page.getByTestId('open-orders-list');
      await expect(list).toBeVisible();
      await expect(list.getByTestId(/^open-orders-row-.*-who$/)).toHaveCount(open);
      await expect(page.getByTestId('cart-empty')).toBeHidden();
      const first = list.getByTestId(/^open-orders-row-.*-total$/).first();
      const total = (await first.textContent())!;
      await first.click();
      await expect(list).toHaveCount(0);
      await expect(page.getByTestId('cart-checkout')).toContainText(total);
    });
  });
}
