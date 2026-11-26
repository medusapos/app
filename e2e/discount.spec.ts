import { expect, type Locator, type Page } from '@playwright/test';
import { addE2E1, adminToken, backend, captureCommands, cartLineRow, cartTaxRow, cartTotalRow, discount, ordersByClientId, sellBySku, signIn, tenderCash, test } from './helpers';
import { appliedResponse, saleResults } from './helpers';

// Discounts in the cart: the plugin reports order.create [1, 2, 3, 4, 5, 6, 7] at GET /tally/v1/info,
// and a discounted sale without charges or custom lines goes out as version 4, with one net "POS discount" adjustment per line.
const UNSUPPORTED = 'finalize: discounts are not supported by the server yet (order.create v2)';
type Sale = { clientOrderId: string; lines: { discountMinor?: number }[] };
const capabilities = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('medusapos.session') ?? 'null')?.capabilities);

test('a discounted sale is applied as order.create v4, with a "POS discount" adjustment of the line\'s discount', async ({ page }) => {
  const token = await adminToken();
  const commands = captureCommands<Sale>(page);
  const info = page.waitForResponse(response => new URL(response.url()).pathname === '/tally/v1/info' && response.request().method() === 'GET');
  await signIn(page);
  // The plugin advertises order.create [1, 2, 3, 4, 5, 6, 7] (ADR 0021), register 1, 2 and 3 (ADR 0022, ADR 0023) and its tax rounding (TallyUI #322); the till stores the plugin's lineTax (TallyUI 3.3.0)
  // and its registerApproval, the plugin's default approvalThresholdMinor of 500 (ADR 0023; parsed since TallyUI 3.13.0, ADR-082).
  // TallyUI ADR-075 sends v5 only for charges or custom lines; discounts without them go out at version 4.
  // The plugin's contract 5 (#540) adds order.refund v1.
  // Contract 6 adds region_id and terminal on GET /tally/v1/payment-providers.
  // The session leaves the customer display out (#554); the plugin still advertises it (ADR-085) at /info,
  // with its default STUN servers (PR #538).
  expect((await (await info).json()).customerDisplay).toEqual({ v: 1,
    iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }, { urls: 'stun:stun.l.google.com:19302' }], snapshot: 1 });
  expect(await capabilities(page)).toEqual({ orderCreate: 7, register: 3, pluginContract: 7, orderRefund: 1,
    coupons: true,
    taxRounding: { granularity: 'per_order', mode: 'half_away_from_zero' }, lineTax: { none: false, classes: false },
    registerApproval: { thresholdMinor: 500 } });
  await addE2E1(page);
  await addE2E1(page);
  await discount(page, 'line', 'Percent', '10');
  await expect(page.getByRole('button', { name: /^Remove discount 10% −\D*0\.40$/ })).toBeVisible();
  await discount(page, 'order', 'Amount', '0.50');
  // v2's order discount is a "Discount −€0.50 ✕" row in the totals, not a chip under the lines (DEMO 05c).
  await expect(page.getByTestId('order-discount-row-0')).toHaveText(/^Discount−\D*0\.50$/);
  // The totals are TallyUI's order.display (ADR-063): Subtotal − Discount + VAT = Total (4.00 − 0.40 − 0.50 + 0.78 = 3.88).
  // The line reads before its discounts (4.00, adding up to the Subtotal); its chip carries its amount. No
  // cart-scroll testID with CartPanel (TallyUI #136): the line's own Remove button scopes to the cart's copy.
  // TallyUI 3.14.0's line is columns (quantity, name, unit price, total), no longer "2.00 × 2".
  await expect(cartLineRow(page, 'E2E product 1')).toHaveText(/^2E2E product 1\D*2\.00\D*4\.00$/);
  await expect(page.getByText(/^10% −\D*0\.40$/)).toBeVisible();
  await expect(page.getByText(/^Order discount/)).toHaveCount(0);
  // The last "Discount" is Cart's totals row, the line's 0.40 alone: the order's 0.50 is its own row above it. The
  // first is the line's action. The VAT row is read by its testID (TallyUI
  // 4.0.0 sets its label and Excluding tax tag apart from the amount).
  const amountOf = async (locator: Locator) => Number((await locator.textContent())!.match(/(\d+\.\d{2})\D*$/)![1]);
  const row = (label: string) => amountOf(page.getByText(label, { exact: true }).last().locator('..'));
  // v2's cart has no Total row: the total is on the Checkout button.
  const total = Number((await page.getByTestId('cart-checkout').textContent())!.match(/(\d+\.\d{2})\D*$/)![1]);
  await expect(cartTaxRow(page)).toHaveText(/^VAT 25%Excluding tax/);
  expect([await row('Subtotal'), await row('Discount'), await amountOf(cartTaxRow(page)), total]).toEqual([4, 0.4, 0.78, 3.88]);
  const applied = appliedResponse(page);
  // Exact cash, as sellBySku pays it, stopping on the receipt to read its rows.
  await page.getByTestId('cart-checkout').click();
  await tenderCash(page, 'exact');
  await page.getByRole('button', { name: 'Complete sale', exact: true }).click();
  for (const label of [/^2 × \D*2\.00: \D*4\.00$/, /^10% off: −\D*0\.40$/, /^Subtotal: \D*4\.00$/,
    /^Line discounts: −\D*0\.40$/, /^Order discount: −\D*0\.50$/, /^VAT 25%: \D*0\.78$/, /^Total: \D*3\.88$/]) {
    await expect(page.getByLabel(label)).toBeVisible();
  }
  await expect(page.getByLabel(/^Discount:/)).toHaveCount(0);
  await page.getByRole('button', { name: 'New sale', exact: true }).click();
  const receiptTotal = 3.88;
  const results = await saleResults(await applied);
  expect(results).toHaveLength(1);
  expect(results[0].status).toBe('applied');
  expect(results[0].warnings).toBeUndefined();
  expect(commands).toHaveLength(1);
  const [{ version, payload }] = commands;
  expect(version).toBe(4);
  // 2 × €2.00, 10% off (€0.40) plus the whole €0.50 order discount on the one line.
  expect(payload.lines).toEqual([expect.objectContaining({ discountMinor: 90 })]);
  const [order] = (await ordersByClientId(token)).filter((entry) => entry.metadata.tally_client_id === payload.clientOrderId);
  // Medusa keeps tax unrounded: €3.10 at 25% is €0.775, so its order total is €3.875 against the till's €3.88.
  // Equal in minor units, as the plugin compares them (no total_mismatch warning above).
  expect(results[0].serverRefs.totalMinor).toBe(Math.round(receiptTotal * 100));
  expect(Math.round(order.total * 100)).toBe(Math.round(receiptTotal * 100));
  const response = await fetch(`${backend}/admin/orders/${order.id}?fields=items.adjustments.*`, { headers: { Authorization: `Bearer ${token}` } });
  expect(response.ok, await response.clone().text()).toBeTruthy();
  const { order: { items } } = await response.json();
  const adjustments = items.flatMap((item: { adjustments: { description: string; amount: number }[] }) => item.adjustments);
  expect(adjustments).toEqual([expect.objectContaining({ description: 'POS discount' })]);
  expect(Math.round(adjustments[0].amount * 100)).toBe(payload.lines[0].discountMinor);
});

// DEMO 05c: v2 shows an order discount once, as a removable "Discount (10%) ✕" row in the totals, never as a chip
// under the lines too. 2 × E2E-1 (€2.00) and E2E-2 (€3.50): €7.50 and 25% VAT, rounded per order.
test('a 10% order discount reads once, as the totals\' "Discount (10%)" row, and its ✕ removes it', async ({ page }) => {
  await signIn(page);
  await addE2E1(page);
  await addE2E1(page);
  const search = page.getByPlaceholder('Search or scan barcode / SKU', { exact: true });
  await search.fill('E2E-2');
  await search.press('Enter');
  const checkout = page.getByTestId('cart-checkout');
  // €7.50 + €1.88 VAT (€1.875 rounded half away from zero).
  await expect(checkout).toHaveText(/\D9\.38$/);
  await discount(page, 'order', 'Percent', '10');
  const row = page.getByTestId('order-discount-row-0');
  await expect(row).toHaveText(/^Discount \(10%\)−\D*0\.75$/);
  await expect(page.getByText('Discount (10%)', { exact: true })).toHaveCount(1);
  await expect(page.getByText(/^Order discount/)).toHaveCount(0);
  // Cart's own Discount row leaves the order discount out, so −€0.75 is in the totals once, on the row.
  await expect(cartTotalRow(page, 'Discount')).toHaveCount(0);
  await expect(page.getByTestId('cart-footer').getByText(/0\.75$/)).toHaveCount(1);
  // €7.50 − €0.75 + €1.69 VAT (€1.6875), the figure the cart showed with the chip (05c's shot of 2026-11-18).
  await expect(checkout).toHaveText(/\D8\.44$/);
  await page.getByTestId('order-discount-remove-0').click();
  await expect(row).toHaveCount(0);
  await expect(checkout).toHaveText(/\D9\.38$/);
});

test('below order.create v2 the till refuses a discount when it is applied, and the sale completes without it', async ({ page }) => {
  // An old plugin: GET /tally/v1/info is a 404 (the real response's CORS headers kept).
  await page.route(`${backend}/tally/v1/info`, async (route) => route.fulfill({ response: await route.fetch(), status: 404, body: '{}' }));
  const commands = captureCommands<Sale>(page);
  await signIn(page, 'Europe', 'unsynced');
  expect(await capabilities(page)).toEqual({ orderCreate: 1 });
  await addE2E1(page);
  await discount(page, 'line', 'Percent', '10');
  await expect(page.getByText(UNSUPPORTED, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Remove discount/ })).toHaveCount(0);
  expect(commands).toHaveLength(0);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await sellBySku(page, [], 'exact')).toBe(2.5);
  await expect(page.getByText('Sales are up to date.', { exact: true })).toBeVisible();
  expect(commands.map((command) => command.version)).toEqual([1]);
});

// The plugin completes a zero-total sale without a payment collection (#62).
test('100% off the line completes with cash at €0.00 as one Medusa order', async ({ page }) => {
  const token = await adminToken();
  const commands = captureCommands<Sale>(page);
  await signIn(page);
  await addE2E1(page);
  await discount(page, 'line', 'Percent', '100');
  await expect(page.getByTestId('cart-checkout')).toContainText('0.00');
  const applied = appliedResponse(page);
  await page.getByTestId('cart-checkout').click();
  await page.getByRole('button', { name: 'Complete sale', exact: true }).click();
  await expect(page.getByLabel(/^Total: /)).toHaveAttribute('aria-label', /^Total: \D*0\.00$/);
  const results = await saleResults(await applied);
  expect(results).toEqual([expect.objectContaining({ status: 'applied' })]);
  expect(results[0].warnings).toBeUndefined();
  expect(results[0].serverRefs.totalMinor).toBe(0);
  expect(commands).toHaveLength(1);
  expect(commands[0].version).toBe(4);
  const orders = (await ordersByClientId(token)).filter((order) => order.metadata.tally_client_id === commands[0].payload.clientOrderId);
  expect(orders).toHaveLength(1);
  expect(orders[0].total).toBe(0);
  await page.getByRole('button', { name: 'New sale', exact: true }).click();
});
