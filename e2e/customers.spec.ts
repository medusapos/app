import { expect, type Page } from '@playwright/test';
import { addE2E1, adminToken, backend, captureCommands, createAdminCustomer, credentials, inventoryLevel, openArea, ordersByClientId, setInventoryLevel, signIn,
  tenderCash, test } from './helpers';

type Sale = { clientOrderId: string; customer: { customerId: string } };
async function payCash(page: Page) {
  await page.getByTestId('cart-checkout').click();
  await tenderCash(page, 'exact');
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
  await page.getByTestId('customer-dropdown-search').fill(email);
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
  await page.getByTestId('cart-add-menu').click();
  await page.getByTestId('cart-add-new-customer').click();
  await page.getByPlaceholder('First name', { exact: true }).fill('Grace');
  await page.getByPlaceholder('Last name', { exact: true }).fill('Hopper');
  await page.getByPlaceholder('email@example.com', { exact: true }).fill(email);
  await page.getByRole('button', { name: 'Add Customer', exact: true }).click();
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

test('a sale with the Settings default customer reaches Medusa with the customer\'s email', async ({ page }) => {
  const token = await adminToken();
  const email = `default-${crypto.randomUUID()}@example.com`;
  const id = await createAdminCustomer(token, email, 'Ada', 'Lovelace');
  // The suite shares E2E-1 stock: give it back once every sale this test sent has applied, also on failure.
  const level = await inventoryLevel(token, 'E2E-1');
  const commands = captureCommands<Sale>(page);
  try {
    await signIn(page);
    await openArea(page, 'Settings');
    await page.getByTestId('settings-nav-store').click();
    await page.getByTestId('settings-default-customer-field').click();
    await page.getByTestId('customer-picker-search').fill(email);
    await page.getByLabel(`Ada Lovelace, ${email}`, { exact: true }).click();
    await expect(page.getByTestId('settings-default-customer-current')).toHaveText('Ada Lovelace');
    await openArea(page, 'POS');
    await expect(page.getByRole('button', { name: 'Customer: Ada Lovelace', exact: true })).toBeVisible();
    await addE2E1(page);
    await payCash(page);
    await expect.poll(() => commands.find((command) => command.status === 'applied')?.payload.customer.customerId).toBe(id);
    const orders = (await ordersByClientId(token)).filter((order) => order.metadata.tally_client_id === commands[0].payload.clientOrderId);
    expect(orders).toHaveLength(1);
    const response = await fetch(`${backend}/admin/orders/${orders[0].id}?fields=id,email,customer_id`, { headers: { Authorization: `Bearer ${token}` } });
    expect(response.ok, await response.clone().text()).toBeTruthy();
    const { order } = await response.json() as { order: { id: string; email: string | null; customer_id: string | null } };
    const expectedEmail = email;
    expect(order.email).toBe(expectedEmail);
    expect(order.customer_id).toBe(id);
    await openArea(page, 'Settings');
    await page.getByTestId('settings-nav-store').click();
    await page.getByTestId('settings-default-customer-field').click();
    await page.getByTestId('settings-default-customer-guest').click();
    await expect(page.getByTestId('settings-default-customer-current')).toHaveText('Guest');
  } finally {
    try {
      await expect.poll(() => commands.every(({ status }) => status === 'applied')).toBe(true);
    } finally {
      await setInventoryLevel(token, level.inventoryItemId, level.locationId, level.stockedQuantity);
    }
  }
});

test('the Default customer is cashier switch starts the sale on the signed-in cashier\'s Medusa customer', async ({ page }) => {
  const token = await adminToken();
  type Found = { id: string; email: string; first_name: string | null; last_name: string | null; company_name: string | null };
  const response = await fetch(`${backend}/admin/customers?q=${encodeURIComponent(credentials.email)}`, { headers: { Authorization: `Bearer ${token}` } });
  expect(response.ok, await response.clone().text()).toBeTruthy();
  const { customers } = await response.json() as { customers: Found[] };
  let cashier = customers.find((customer) => customer.email.toLowerCase() === credentials.email.toLowerCase());
  if (!cashier) {
    const id = await createAdminCustomer(token, credentials.email, 'E2E', 'Cashier');
    cashier = { id, email: credentials.email, first_name: 'E2E', last_name: 'Cashier', company_name: null };
  }
  // The app's name for a Medusa customer: first and last name, else company, else email.
  const name = [cashier.first_name, cashier.last_name].filter(Boolean).join(' ') || cashier.company_name || cashier.email;
  await signIn(page);
  await openArea(page, 'Settings');
  await page.getByTestId('settings-nav-store').click();
  await page.getByRole('switch', { name: 'Default customer is cashier', exact: true }).click();
  await expect(page.getByTestId('settings-default-customer-cashier-status'))
    .toHaveText(`New sales start on ${name}, the customer in Medusa with your email.`);
  await openArea(page, 'POS');
  await expect(page.getByRole('button', { name: `Customer: ${name}`, exact: true })).toBeVisible();
});

test('the cart customer chip\'s address button edits the customer\'s billing address in Medusa', async ({ page }) => {
  const token = await adminToken();
  const email = `chip-address-${crypto.randomUUID()}@example.com`;
  await createAdminCustomer(token, email, 'Ada', 'Lovelace');
  await signIn(page);
  await page.getByRole('button', { name: 'Customer: Guest', exact: true }).click();
  await page.getByTestId('customer-dropdown-search').fill(email);
  await page.getByLabel(`Ada Lovelace, ${email}`, { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Customer: Ada Lovelace', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit Customer Address', exact: true }).click();
  const dialog = page.getByTestId('customer-address-dialog');
  await dialog.getByLabel('Address line 1', { exact: true }).fill('1 Market St');
  await dialog.getByLabel('City', { exact: true }).fill('Leeds');
  await dialog.getByLabel('Postal code', { exact: true }).fill('LS1 1AA');
  await dialog.getByTestId('customer-billing-country').fill('gb');
  await dialog.getByTestId('customer-billing-country-GB').click();
  await dialog.getByTestId('customer-save').click();
  await expect(dialog).not.toBeVisible();
  const response = await fetch(`${backend}/admin/customers?q=${encodeURIComponent(email)}&fields=*addresses`, { headers: { Authorization: `Bearer ${token}` } });
  expect(response.ok, await response.clone().text()).toBeTruthy();
  const { customers } = await response.json();
  expect(customers).toHaveLength(1);
  expect(customers[0].addresses).toHaveLength(1);
  expect(customers[0].addresses[0]).toMatchObject({ is_default_billing: true, address_1: '1 Market St',
    city: 'Leeds', postal_code: 'LS1 1AA', country_code: 'gb' });
});

test('the cart\'s Add new customer is v2\'s Add Customer form', async ({ page }) => {
  const token = await adminToken();
  const email = `cart-added-${crypto.randomUUID()}@example.com`;
  await signIn(page);
  await page.getByTestId('cart-add-menu').click();
  await page.getByRole('menuitem', { name: 'Add new customer', exact: true }).click();
  const dialog = page.getByTestId('new-customer-dialog');
  await expect(dialog.getByRole('heading', { name: 'Add Customer', exact: true })).toBeVisible();
  await expect(dialog.getByText('Addresses and other optional details', { exact: true })).toBeVisible();
  await expect(dialog.getByLabel('Address line 1', { exact: true })).not.toBeVisible();
  await dialog.getByPlaceholder('email@example.com').fill(email);
  await dialog.getByPlaceholder('First name').fill('Nia');
  await dialog.getByRole('button', { name: 'Add Customer', exact: true }).click();
  await expect(page.getByTestId('customer-saved-toast')).toHaveText('Nia saved');
  await expect(page.getByRole('button', { name: 'Customer: Nia', exact: true })).toBeVisible();
  const response = await fetch(`${backend}/admin/customers?q=${encodeURIComponent(email)}`, { headers: { Authorization: `Bearer ${token}` } });
  expect(response.ok, await response.clone().text()).toBeTruthy();
  const { customers } = await response.json();
  expect(customers).toHaveLength(1);
  expect(customers[0]).toMatchObject({ email, first_name: 'Nia' });
});
