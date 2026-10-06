import { expect } from '@playwright/test';
import { addE2E1, adminToken, captureCommands, ordersByClientId, signIn, test } from './helpers';
import { E2E_RUN } from './ports';

const backend = process.env.E2E_BACKEND_URL ?? `http://localhost:${E2E_RUN.backendPort}`;
// OrderCreatePayload v5: charges are fees/shipping; custom items are lines[].custom.
type Sale = { clientOrderId: string; totalMinor: number;
  fees?: { name: string; amountMinor: number }[];
  shipping?: { name: string; amountMinor: number }[];
  lines: { variantId?: string; custom?: { name: string }; quantity: number; unitPriceMinor: number }[] };

test('a sale with a fee, shipping and a custom item reaches Medusa once at the till\'s total, with the shipping as a shipping method', async ({ page }) => {
  const token = await adminToken();
  const commands = captureCommands<Sale>(page);
  await signIn(page);
  await addE2E1(page);
  for (const [kind, name, amount] of [
    ['Fee', 'Gift wrap', '2.00'], ['Shipping', 'Local delivery', '4.95'], ['Custom item', 'Engraving', '3.00'],
  ]) {
    await page.getByRole('button', { name: 'Add charge', exact: true }).click();
    const form = page.getByTestId('charge-form');
    await form.getByRole('button', { name: kind, exact: true }).click();
    await form.getByLabel('Name', { exact: true }).fill(name);
    await form.getByLabel('Amount', { exact: true }).fill(amount);
    await form.getByRole('button', { name: 'Apply', exact: true }).click();
  }
  const tillTotal = page.getByText('Total', { exact: true }).locator('..');
  const totalMinor = Math.round(Number((await tillTotal.textContent())!.match(/(\d+\.\d{2})\D*$/)![1]) * 100);
  await page.getByRole('button', { name: 'Cash', exact: true }).click();
  const tender = page.getByText('Cash Tendered', { exact: true }).locator('..');
  await tender.locator('[tabindex="0"]').first().click();
  await tender.locator('input').fill((totalMinor / 100).toFixed(2));
  const applied = page.waitForResponse(async (response) => {
    const request = response.request();
    if (request.method() !== 'POST' || response.url() !== `${backend}/tally/v1/commands`) return false;
    const sales = request.postDataJSON().commands.filter((command: { type: string }) => command.type === 'order.create');
    return ((await response.json()).results ?? []).some((result: { id: string; status: string }) =>
      result.status === 'applied' && sales.some((sale: { id: string }) => sale.id === result.id));
  });
  await page.getByRole('button', { name: 'Complete sale', exact: true }).click();
  await expect(page.getByLabel(/^Gift wrap: \D*2\.00$/)).toBeVisible();
  await expect(page.getByLabel(/^Local delivery: \D*4\.95$/)).toBeVisible();
  const receiptTotal = page.getByLabel(/^Total: /);
  await expect(receiptTotal).toBeVisible();
  expect(Math.round(Number((await receiptTotal.getAttribute('aria-label'))!.match(/(\d+\.\d{2})\D*$/)![1]) * 100)).toBe(totalMinor);
  const { results } = await (await applied).json();
  await page.getByRole('button', { name: 'New sale', exact: true }).click();
  await page.reload();
  await expect(page.getByText('Sales are up to date.', { exact: true })).toBeVisible();
  expect(commands).toHaveLength(1);
  const [{ id, version, payload }] = commands;
  expect(version).toBe(5);
  expect(payload.totalMinor).toBe(totalMinor);
  expect(results.filter((result: { id: string }) => result.id === id)).toEqual([
    expect.objectContaining({ status: 'applied', serverRefs: expect.objectContaining({ totalMinor }) }),
  ]);
  expect(payload.fees).toEqual([expect.objectContaining({ name: 'Gift wrap', amountMinor: 200 })]);
  expect(payload.shipping).toEqual([expect.objectContaining({ name: 'Local delivery', amountMinor: 495 })]);
  expect(payload.lines.filter((line) => line.custom)).toEqual([
    expect.objectContaining({ custom: expect.objectContaining({ name: 'Engraving' }), quantity: 1, unitPriceMinor: 300 }),
  ]);
  const orders = (await ordersByClientId(token)).filter((order) => order.metadata.tally_client_id === payload.clientOrderId);
  expect(orders).toHaveLength(1);
  expect(Math.round(orders[0].total * 100)).toBe(totalMinor);
  const response = await fetch(`${backend}/admin/orders/${orders[0].id}?fields=id,total,items.title,items.variant_id,items.quantity,shipping_methods.name,shipping_methods.amount`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.ok, await response.clone().text()).toBeTruthy();
  const { order } = await response.json() as { order: { total: number;
    shipping_methods: { name: string; amount: number }[];
    items: { title: string; variant_id: string | null; quantity: number }[] } };
  expect(Math.round(order.total * 100)).toBe(totalMinor);
  expect(order.shipping_methods).toHaveLength(1);
  expect(order.shipping_methods[0].name).toBe('Local delivery');
  expect(Math.round(order.shipping_methods[0].amount * 100)).toBe(495);
  expect(order.items).toHaveLength(3);
  expect(order.items.filter((item) => item.variant_id === null)).toEqual(expect.arrayContaining([
    expect.objectContaining({ title: 'Gift wrap', variant_id: null, quantity: 1 }),
    expect.objectContaining({ title: 'Engraving', variant_id: null, quantity: 1 }),
  ]));
  expect(order.items.filter((item) => item.variant_id !== null)).toEqual([
    expect.objectContaining({ title: 'E2E product 1', variant_id: expect.any(String), quantity: 1 }),
  ]);
});
