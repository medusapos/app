import { expect, type Page } from '@playwright/test';
import { addE2E1, adminToken, captureCommands, discount, ordersByClientId, sellBySku, signIn, test } from './helpers';
import { E2E_RUN } from './ports';

const backend = process.env.E2E_BACKEND_URL ?? `http://localhost:${E2E_RUN.backendPort}`;
type Sale = { clientOrderId: string; totalMinor: number;
  lines: { quantity: number; unitPriceMinor: number; discountMinor?: number }[] };
const appliedResponse = (page: Page) => page.waitForResponse(async (response) => {
  const request = response.request();
  if (request.method() !== 'POST' || response.url() !== `${backend}/tally/v1/commands`) return false;
  const sales = request.postDataJSON().commands.filter((command: { type: string }) => command.type === 'order.create');
  return ((await response.json()).results ?? []).some((result: { id: string; status: string }) =>
    result.status === 'applied' && sales.some((sale: { id: string }) => sale.id === result.id));
});

test('park a sale, sell another, resume the first and complete it: both orders reach Medusa once at the till\'s figures', async ({ page }) => {
  const token = await adminToken();
  const commands = captureCommands<Sale>(page);
  await signIn(page);
  await addE2E1(page);
  await addE2E1(page);
  await page.getByRole('button', { name: 'Parked sales', exact: true }).click();
  await page.getByTestId('parked-sales-park').click();
  await expect(page.getByTestId(/^parked-resume-/)).toHaveCount(1);
  await page.getByTestId('parked-sales-dismiss').click();
  await expect(page.getByTestId('cart-empty')).toBeVisible();
  expect(commands).toHaveLength(0);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Parked sales (1)', exact: true })).toBeVisible();
  const secondApplied = appliedResponse(page);
  expect(await sellBySku(page, ['E2E-1'], 'exact')).toBe(2.5);
  const second = (await (await secondApplied).json()).results;
  await page.getByRole('button', { name: 'Parked sales (1)', exact: true }).click();
  await page.getByTestId(/^parked-resume-/).click();
  await expect(page.getByText('Total', { exact: true }).locator('..')).toContainText('5.00');
  await expect(page.getByRole('button', { name: 'Parked sales', exact: true })).toBeVisible();
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
  await page.getByText('Price', { exact: true }).click();
  await page.getByLabel('Price value', { exact: true }).fill('3.20');
  await page.getByLabel('Reason (optional)', { exact: true }).fill('Shelf price');
  await page.getByTestId('price-apply').click();
  await expect(page.getByText('Total', { exact: true }).locator('..')).toContainText('7.20');
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
