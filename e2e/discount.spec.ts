import { expect, test, type Page } from '@playwright/test';
import { addE2E1, adminToken, discount, ordersByClientId, sellBySku, signIn } from './helpers';
import { E2E_RUN } from './ports';

// Discounts in the cart (TallyUI ADR-062): the plugin reports order.create [1, 2] at GET /tally/v1/info,
// and a discounted sale goes out as order.create version 2, with one "POS discount" adjustment per line.
const backend = process.env.E2E_BACKEND_URL ?? `http://localhost:${E2E_RUN.backendPort}`;
const UNSUPPORTED = 'finalize: discounts are not supported by the server yet (order.create v2)';
type Command = { version: number; payload: { clientOrderId: string; lines: { discountMinor?: number }[] } };

function captureCommands(page: Page): Command[] {
  const commands: Command[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url() === `${backend}/tally/v1/commands`) commands.push(...request.postDataJSON().commands);
  });
  return commands;
}
const appliedResponse = (page: Page) => page.waitForResponse(async (response) => {
  if (response.request().method() !== 'POST' || response.url() !== `${backend}/tally/v1/commands`) return false;
  return ((await response.json()).results ?? []).some((result: { status: string }) => result.status === 'applied');
});
const capabilities = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('medusapos.session') ?? 'null')?.capabilities);

test('a discounted sale is applied as order.create v2, with a "POS discount" adjustment of the line\'s discount', async ({ page }) => {
  const token = await adminToken();
  const commands = captureCommands(page);
  await signIn(page);
  expect(await capabilities(page)).toEqual({ orderCreate: 2 });
  await addE2E1(page);
  await addE2E1(page);
  await discount(page, 'line', 'Percent', '10');
  await expect(page.getByRole('button', { name: /^Remove discount 10% −\D*0\.40$/ })).toBeVisible();
  await discount(page, 'order', 'Amount', '0.50');
  await expect(page.getByRole('button', { name: /^Remove discount .*0\.50/ })).toBeVisible();
  // The totals are TallyUI's order.display (ADR-063): Subtotal − Discount + VAT = Total (4.00 − 0.90 + 0.78 = 3.88).
  // The line reads before its discounts (4.00, adding up to the Subtotal); each chip carries its amount.
  await expect(page.getByTestId('cart-scroll').getByText('E2E product 1', { exact: true }).locator('../..')).toHaveText(/× 2\D*4\.00$/);
  await expect(page.getByText(/^10% −\D*0\.40$/)).toBeVisible();
  await expect(page.getByText(/^Order discount −.*0\.50$/)).toBeVisible();
  // The last "Discount" is the totals row; the first is the line's action.
  const row = async (label: string) => Number((await page.getByText(label, { exact: true }).last().locator('..').textContent())!.match(/(\d+\.\d{2})\D*$/)![1]);
  expect([await row('Subtotal'), await row('Discount'), await row('VAT 25%'), await row('Total')]).toEqual([4, 0.9, 0.78, 3.88]);
  const applied = appliedResponse(page);
  // Exact cash, as sellBySku pays it, stopping on the receipt to read its rows.
  await page.getByRole('button', { name: 'Cash', exact: true }).click();
  const tender = page.getByText('Cash Tendered', { exact: true }).locator('..');
  const amount = tender.locator('input');
  await tender.locator('[tabindex="0"]').first().click();
  await amount.fill(await amount.inputValue());
  await page.getByRole('button', { name: 'Complete sale', exact: true }).click();
  for (const label of [/^2 × \D*2\.00: \D*4\.00$/, /^10% off: −\D*0\.40$/, /^Order discount: −\D*0\.50$/,
    /^Subtotal: \D*4\.00$/, /^Discount: −\D*0\.90$/, /^VAT 25%: \D*0\.78$/, /^Total: \D*3\.88$/]) {
    await expect(page.getByLabel(label)).toBeVisible();
  }
  await page.getByRole('button', { name: 'New sale', exact: true }).click();
  const receiptTotal = 3.88;
  const { results } = await (await applied).json();
  expect(results).toHaveLength(1);
  expect(results[0].status).toBe('applied');
  expect(results[0].warnings).toBeUndefined();
  expect(commands).toHaveLength(1);
  const [{ version, payload }] = commands;
  expect(version).toBe(2);
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

test('below order.create v2 the till refuses a discount when it is applied, and the sale completes without it', async ({ page }) => {
  // An old plugin: GET /tally/v1/info is a 404 (the real response's CORS headers kept).
  await page.route(`${backend}/tally/v1/info`, async (route) => route.fulfill({ response: await route.fetch(), status: 404, body: '{}' }));
  const commands = captureCommands(page);
  await signIn(page);
  expect(await capabilities(page)).toEqual({ orderCreate: 1 });
  await addE2E1(page);
  await discount(page, 'line', 'Percent', '10');
  await expect(page.getByText(UNSUPPORTED, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Remove discount/ })).toHaveCount(0);
  expect(commands).toHaveLength(0);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await sellBySku(page, [], 'exact')).toBe(2.5);
  await expect(page.getByText('All sales synced', { exact: true })).toBeVisible();
  expect(commands.map((command) => command.version)).toEqual([1]);
});

// The plugin completes a zero-total sale without a payment collection (#62).
test('100% off the line completes with cash at €0.00 as one Medusa order', async ({ page }) => {
  const token = await adminToken();
  const commands = captureCommands(page);
  await signIn(page);
  await addE2E1(page);
  await discount(page, 'line', 'Percent', '100');
  const row = page.getByText('Total', { exact: true }).locator('..');
  await expect(row).toContainText('0.00');
  const applied = appliedResponse(page);
  await page.getByRole('button', { name: 'Cash', exact: true }).click();
  await page.getByRole('button', { name: 'Complete sale', exact: true }).click();
  await expect(page.getByLabel(/^Total: /)).toHaveAttribute('aria-label', /^Total: \D*0\.00$/);
  const { results } = await (await applied).json();
  expect(results).toEqual([expect.objectContaining({ status: 'applied' })]);
  expect(results[0].warnings).toBeUndefined();
  expect(results[0].serverRefs.totalMinor).toBe(0);
  expect(commands).toHaveLength(1);
  expect(commands[0].version).toBe(2);
  const orders = (await ordersByClientId(token)).filter((order) => order.metadata.tally_client_id === commands[0].payload.clientOrderId);
  expect(orders).toHaveLength(1);
  expect(orders[0].total).toBe(0);
  await page.getByRole('button', { name: 'New sale', exact: true }).click();
});
