import { expect, test, type Page } from '@playwright/test';
import { adminToken, ordersByClientId, sellBySku, signIn } from './helpers';
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
async function addE2E1(page: Page) {
  const search = page.getByPlaceholder('Search or scan barcode / SKU', { exact: true });
  await search.fill('E2E-1');
  await search.press('Enter');
  await expect(search).toHaveValue('');
}
async function discount(page: Page, opener: 'line' | 'order', type: 'Percent' | 'Amount', value: string) {
  await (opener === 'line' ? page.getByText('Discount', { exact: true }) : page.getByRole('button', { name: 'Order discount', exact: true })).click();
  await page.getByRole('button', { name: type, exact: true }).click();
  await page.getByLabel('Discount value', { exact: true }).fill(value);
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
}
const capabilities = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('medusapos.session') ?? 'null')?.capabilities);

test('a discounted sale is applied as order.create v2, with a "POS discount" adjustment of the line\'s discount', async ({ page }) => {
  const token = await adminToken();
  const commands = captureCommands(page);
  await signIn(page);
  expect(await capabilities(page)).toEqual({ orderCreate: 2 });
  await addE2E1(page);
  await addE2E1(page);
  await discount(page, 'line', 'Percent', '10');
  await expect(page.getByRole('button', { name: 'Remove discount 10%', exact: true })).toBeVisible();
  await discount(page, 'order', 'Amount', '0.50');
  await expect(page.getByRole('button', { name: /^Remove discount .*0\.50/ })).toBeVisible();
  const applied = page.waitForResponse(async (response) => {
    if (response.request().method() !== 'POST' || response.url() !== `${backend}/tally/v1/commands`) return false;
    return ((await response.json()).results ?? []).some((result: { status: string }) => result.status === 'applied');
  });
  const receiptTotal = await sellBySku(page, [], 'exact');
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
