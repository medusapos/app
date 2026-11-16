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
