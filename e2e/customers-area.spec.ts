import { expect } from '@playwright/test';
import { adminToken, backend, createAdminCustomer, openArea, signIn, test } from './helpers';

test('the Customers area finds and edits a customer', async ({ page }) => {
  const token = await adminToken();
  const email = `edited-${crypto.randomUUID()}@example.com`;
  const id = await createAdminCustomer(token, email, 'Ada', 'Lovelace');
  await signIn(page);
  await openArea(page, 'Customers');
  await page.getByTestId('customers-search').fill(email);
  await page.getByLabel(`Ada Lovelace, ${email}`, { exact: true }).click();
  await page.getByPlaceholder('Phone number').fill('+44 20 7946 0000');
  await page.getByTestId('customer-save').click();
  await expect(page.getByLabel(`Ada Lovelace, ${email}, +44 20 7946 0000`, { exact: true })).toBeVisible();
  const response = await fetch(`${backend}/admin/customers/${id}`, { headers: { Authorization: `Bearer ${token}` } });
  expect(response.ok, await response.clone().text()).toBeTruthy();
  const { customer } = await response.json();
  expect(customer.phone).toBe('+44 20 7946 0000');
});

test('the Customers area adds a customer', async ({ page }) => {
  const token = await adminToken();
  const email = `created-${crypto.randomUUID()}@example.com`;
  await signIn(page);
  await openArea(page, 'Customers');
  await page.getByTestId('customers-add').click();
  await page.getByPlaceholder('email@example.com').fill(email);
  await page.getByPlaceholder('First name').fill('Nia');
  await page.getByTestId('customer-save').click();
  await expect(page.getByLabel(`Nia, ${email}`, { exact: true })).toBeVisible();
  const response = await fetch(`${backend}/admin/customers?q=${encodeURIComponent(email)}`, { headers: { Authorization: `Bearer ${token}` } });
  expect(response.ok, await response.clone().text()).toBeTruthy();
  const { customers } = await response.json();
  expect(customers).toHaveLength(1);
  expect(customers[0]).toMatchObject({ email, first_name: 'Nia' });
});

test('the Customers area adds a customer with a billing address', async ({ page }) => {
  const token = await adminToken();
  const email = `billing-${crypto.randomUUID()}@example.com`;
  await signIn(page);
  await openArea(page, 'Customers');
  await page.getByTestId('customers-add').click();
  await page.getByPlaceholder('email@example.com').fill(email);
  await page.getByPlaceholder('First name').fill('Nia');
  await page.getByLabel('Address line 1', { exact: true }).fill('1 Market St');
  await page.getByLabel('City', { exact: true }).fill('Leeds');
  await page.getByLabel('Postal code', { exact: true }).fill('LS1 1AA');
  await page.getByLabel('Country code', { exact: true }).fill('gb');
  await page.getByTestId('customer-save').click();
  await expect(page.getByTestId('customer-editor')).not.toBeVisible();
  await expect(page.getByLabel(`Nia, ${email}`, { exact: true })).toBeVisible();
  const response = await fetch(`${backend}/admin/customers?q=${encodeURIComponent(email)}&fields=*addresses`, { headers: { Authorization: `Bearer ${token}` } });
  expect(response.ok, await response.clone().text()).toBeTruthy();
  const { customers } = await response.json();
  expect(customers).toHaveLength(1);
  expect(customers[0].addresses).toHaveLength(1);
  expect(customers[0].addresses[0]).toMatchObject({ is_default_billing: true, first_name: 'Nia', address_1: '1 Market St',
    city: 'Leeds', postal_code: 'LS1 1AA', country_code: 'gb' });
});

test('the Customers area edits a stored billing address in place', async ({ page }) => {
  const token = await adminToken();
  const email = `billing-edit-${crypto.randomUUID()}@example.com`;
  const id = await createAdminCustomer(token, email, 'Ada', 'Lovelace');
  const created = await fetch(`${backend}/admin/customers/${id}/addresses`, { method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ first_name: 'Ada', address_1: '1 Old St', city: 'London', postal_code: 'N1 1AA',
      country_code: 'gb', is_default_billing: true }) });
  expect(created.ok, await created.clone().text()).toBeTruthy();
  const before = await fetch(`${backend}/admin/customers/${id}?fields=*addresses`, { headers: { Authorization: `Bearer ${token}` } });
  expect(before.ok, await before.clone().text()).toBeTruthy();
  const { customer: initial } = await before.json();
  expect(initial.addresses).toHaveLength(1);
  const addressId = initial.addresses[0].id;
  await signIn(page);
  await openArea(page, 'Customers');
  await page.getByTestId('customers-search').fill(email);
  await page.getByLabel(`Ada Lovelace, ${email}`, { exact: true }).click();
  await expect(page.getByLabel('Address line 1', { exact: true })).toHaveValue('1 Old St');
  await page.getByLabel('City', { exact: true }).fill('Leeds');
  await page.getByTestId('customer-save').click();
  await expect(page.getByTestId('customer-editor')).not.toBeVisible();
  const response = await fetch(`${backend}/admin/customers/${id}?fields=*addresses`, { headers: { Authorization: `Bearer ${token}` } });
  expect(response.ok, await response.clone().text()).toBeTruthy();
  const { customer } = await response.json();
  expect(customer.addresses).toHaveLength(1);
  expect(customer.addresses[0]).toMatchObject({ id: addressId, city: 'Leeds', address_1: '1 Old St', first_name: 'Ada' });
});
