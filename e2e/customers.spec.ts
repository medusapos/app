import { expect, type Page } from '@playwright/test';
import { addE2E1, adminToken, captureCommands, createAdminCustomer, ordersByClientId, signIn, test } from './helpers';
import { E2E_RUN } from './ports';

const backend = process.env.E2E_BACKEND_URL ?? `http://localhost:${E2E_RUN.backendPort}`;
type Sale = { clientOrderId: string; customer: { customerId: string } };
async function payCash(page: Page) {
  await page.getByRole('button', { name: 'Cash', exact: true }).click();
  const tender = page.getByText('Cash Tendered', { exact: true }).locator('..');
  const amount = tender.locator('input');
  await tender.locator('[tabindex="0"]').first().click();
  await amount.fill(await amount.inputValue());
  await page.getByRole('button', { name: 'Complete sale', exact: true }).click();
  await expect(page.getByRole('button', { name: 'New sale', exact: true })).toBeVisible();
}

test('a searched customer is linked to the Medusa order', async ({ page }) => {
  const token = await adminToken();
  const email = `searched-${crypto.randomUUID()}@example.com`;
  const id = await createAdminCustomer(token, email, 'Ada', 'Lovelace');
  const commands = captureCommands<Sale>(page);
  await signIn(page);
  await addE2E1(page);
  await page.getByRole('button', { name: 'Customer: Guest', exact: true }).click();
  await page.getByLabel('Search customers', { exact: true }).fill(email);
  await page.getByLabel(`Ada Lovelace, ${email}`, { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Customer: Ada Lovelace', exact: true })).toBeVisible();
  await payCash(page);
  await expect(page.getByText('Customer: Ada Lovelace', { exact: true })).toBeVisible();
  await expect.poll(() => commands.find((command) => command.status === 'applied')?.payload.customer.customerId).toBe(id);
  const clientId = commands[0].payload.clientOrderId;
  const orders = (await ordersByClientId(token)).filter((order) => order.metadata.tally_client_id === clientId);
  expect(orders).toHaveLength(1);
  expect(orders[0].customer_id).toBe(id);
});

test('a customer created at the till is linked to the Medusa order', async ({ page }) => {
  const token = await adminToken();
  const email = `created-${crypto.randomUUID()}@example.com`;
  const commands = captureCommands<Sale>(page);
  await signIn(page);
  await page.getByRole('button', { name: 'Customer: Guest', exact: true }).click();
  await page.getByRole('button', { name: 'New customer', exact: true }).click();
  await page.getByPlaceholder('First name', { exact: true }).fill('Grace');
  await page.getByPlaceholder('Last name', { exact: true }).fill('Hopper');
  await page.getByPlaceholder('email@example.com', { exact: true }).fill(email);
  await page.getByRole('button', { name: 'Save Customer', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Customer: Grace Hopper', exact: true })).toBeVisible();
  await addE2E1(page);
  await payCash(page);
  const response = await fetch(`${backend}/admin/customers?q=${encodeURIComponent(email)}`, { headers: { Authorization: `Bearer ${token}` } });
  expect(response.ok, await response.clone().text()).toBeTruthy();
  const { customers } = await response.json();
  expect(customers).toHaveLength(1);
  const id = customers[0].id;
  await expect.poll(() => commands.find((command) => command.status === 'applied')?.payload.customer.customerId).toBe(id);
  const orders = (await ordersByClientId(token)).filter((order) => order.metadata.tally_client_id === commands[0].payload.clientOrderId);
  expect(orders).toHaveLength(1);
  expect(orders[0].customer_id).toBe(id);
});
