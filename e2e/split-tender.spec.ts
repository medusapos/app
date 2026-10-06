import { expect } from '@playwright/test';
import { addE2E1, adminToken, captureCommands, ordersByClientId, signIn, test } from './helpers';
import { E2E_RUN } from './ports';

const backend = process.env.E2E_BACKEND_URL ?? `http://localhost:${E2E_RUN.backendPort}`;
type Sale = { clientOrderId: string; totalMinor: number;
  payments: { method: string; amountMinor: number; tenderedMinor?: number; changeMinor?: number }[] };

test('a split card-and-cash sale reaches Medusa once at the till\'s total, with both payments, and the receipt lists both', async ({ page }) => {
  const token = await adminToken();
  const commands = captureCommands<Sale>(page);
  await signIn(page);
  await addE2E1(page);
  await addE2E1(page);
  const tillTotal = page.getByText('Total', { exact: true }).locator('..');
  await expect(tillTotal).toHaveText(/Total\D*5\.00$/);
  const totalMinor = Math.round(Number((await tillTotal.textContent())!.match(/(\d+\.\d{2})\D*$/)![1]) * 100);
  await page.getByRole('button', { name: 'Cash', exact: true }).click();
  await page.getByRole('button', { name: 'Split payment', exact: true }).click();
  await expect(page.getByText('Cash Tendered', { exact: true })).toHaveCount(0);
  await page.getByTestId('split-tender-method-card').click();
  await page.getByTestId('split-tender-amount').fill('2.00');
  await page.getByTestId('split-tender-add-button').click();
  await expect(page.getByTestId('split-tender-summary')).toContainText('Remaining: €3.00');
  await page.getByTestId('split-tender-method-cash').click();
  await page.getByTestId('split-tender-amount').fill('5.00');
  await page.getByTestId('split-tender-add-button').click();
  await expect(page.getByTestId('split-tender-summary')).toContainText('Change: €2.00');
  const applied = page.waitForResponse(async (response) => {
    const request = response.request();
    if (request.method() !== 'POST' || response.url() !== `${backend}/tally/v1/commands`) return false;
    const sales = request.postDataJSON().commands.filter((command: { type: string }) => command.type === 'order.create');
    return ((await response.json()).results ?? []).some((result: { id: string; status: string }) =>
      result.status === 'applied' && sales.some((sale: { id: string }) => sale.id === result.id));
  });
  await page.getByTestId('split-tender-complete').click();
  await expect(page.getByLabel(/^Total: \D*5\.00$/)).toBeVisible();
  await expect(page.getByLabel(/^Card terminal: \D*2\.00$/)).toBeVisible();
  await expect(page.getByLabel(/^Cash tendered: \D*5\.00$/)).toBeVisible();
  await expect(page.getByLabel(/^Change: \D*2\.00$/)).toBeVisible();
  const { results } = await (await applied).json();
  await page.getByRole('button', { name: 'New sale', exact: true }).click();
  await page.reload();
  await expect(page.getByText('Sales are up to date.', { exact: true })).toBeVisible();
  expect(commands).toHaveLength(1);
  const [{ id, payload }] = commands;
  expect(results.filter((result: { id: string }) => result.id === id)).toEqual([
    expect.objectContaining({ status: 'applied', serverRefs: expect.objectContaining({ totalMinor }) }),
  ]);
  expect(payload.totalMinor).toBe(totalMinor);
  expect(payload.payments).toEqual([
    expect.objectContaining({ method: 'external', amountMinor: 200 }),
    expect.objectContaining({ method: 'cash', amountMinor: 300, tenderedMinor: 500, changeMinor: 200 }),
  ]);
  const orders = (await ordersByClientId(token)).filter((order) => order.metadata.tally_client_id === payload.clientOrderId);
  expect(orders).toHaveLength(1);
  expect(Math.round(orders[0].total * 100)).toBe(totalMinor);
  expect(orders[0].payment_status).toBe('captured');
  expect(orders[0].metadata).toHaveProperty('tally_payments', expect.any(Array));
  expect((orders[0].metadata as { tally_payments: unknown[] }).tally_payments).toHaveLength(2);
});
