import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { adminToken, backend, createAdminCustomer, openArea, signIn, test } from './helpers';

test('the Customers area saves a different shipping address beside the stored billing one', async ({ page }) => {
  const token = await adminToken();
  const email = `shipping-${crypto.randomUUID()}@example.com`;
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
  const billingId = initial.addresses[0].id;
  await signIn(page);
  await openArea(page, 'Customers');
  await page.getByTestId('customers-search').fill(email);
  await page.getByLabel(`Ada Lovelace, ${email}`, { exact: true }).click();
  await expect(page.getByLabel('Address line 1', { exact: true })).toHaveValue('1 Old St');
  await expect(page.getByText('Same as billing', { exact: true })).toBeVisible();
  await page.getByTestId('customer-shipping-different').click();
  await page.getByLabel('Shipping address line 1', { exact: true }).fill('2 Dock Rd');
  await page.getByLabel('Shipping city', { exact: true }).fill('Hull');
  await page.getByLabel('Shipping postal code', { exact: true }).fill('HU1 1AA');
  await page.getByTestId('customer-shipping-country').fill('gb');
  await page.getByTestId('customer-shipping-country-GB').click();
  await page.getByTestId('customer-save').click();
  await expect(page.getByTestId('customer-editor')).not.toBeVisible();
  const response = await fetch(`${backend}/admin/customers/${id}?fields=*addresses`, { headers: { Authorization: `Bearer ${token}` } });
  expect(response.ok, await response.clone().text()).toBeTruthy();
  const { customer } = await response.json();
  expect(customer.addresses).toHaveLength(2);
  const billing = customer.addresses.find((address: { id: string }) => address.id === billingId);
  expect(billing).toMatchObject({ is_default_billing: true, address_1: '1 Old St', city: 'London', postal_code: 'N1 1AA', country_code: 'gb' });
  const shipping = customer.addresses.find((address: { id: string }) => address.id !== billingId);
  expect(shipping).toMatchObject({ is_default_shipping: true, address_1: '2 Dock Rd', city: 'Hull', postal_code: 'HU1 1AA',
    country_code: 'gb' });
});

type Address = { id: string; address_1: string; city: string; postal_code: string; country_code: string;
  is_default_billing: boolean; is_default_shipping: boolean };

const readAddresses = async (token: string, id: string): Promise<Address[]> => {
  const response = await fetch(`${backend}/admin/customers/${id}?fields=*addresses`, { headers: { Authorization: `Bearer ${token}` } });
  expect(response.ok, await response.clone().text()).toBeTruthy();
  return (await response.json()).customer.addresses;
};

// One address record that is both the default billing and the default shipping address, as Medusa v2 allows.
const seedSharedAddress = async () => {
  const token = await adminToken();
  const email = `shipping-shared-${crypto.randomUUID()}@example.com`;
  const id = await createAdminCustomer(token, email, 'Ada', 'Lovelace');
  const created = await fetch(`${backend}/admin/customers/${id}/addresses`, { method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ first_name: 'Ada', address_1: '1 Old St', city: 'London', postal_code: 'N1 1AA',
      country_code: 'gb', is_default_billing: true, is_default_shipping: true }) });
  expect(created.ok, await created.clone().text()).toBeTruthy();
  const initial = await readAddresses(token, id);
  expect(initial).toHaveLength(1);
  expect(initial[0]).toMatchObject({ is_default_billing: true, is_default_shipping: true });
  return { token, email, id, sharedId: initial[0].id };
};

const openCustomer = async (page: Page, email: string) => {
  await signIn(page);
  await openArea(page, 'Customers');
  await page.getByTestId('customers-search').fill(email);
  await page.getByLabel(`Ada Lovelace, ${email}`, { exact: true }).click();
  await expect(page.getByLabel('Address line 1', { exact: true })).toHaveValue('1 Old St');
};

const fillDifferentShippingAndSave = async (page: Page) => {
  await page.getByTestId('customer-shipping-different').click();
  await page.getByLabel('Shipping address line 1', { exact: true }).fill('2 Dock Rd');
  await page.getByLabel('Shipping city', { exact: true }).fill('Hull');
  await page.getByLabel('Shipping postal code', { exact: true }).fill('HU1 1AA');
  await page.getByTestId('customer-shipping-country').fill('gb');
  await page.getByTestId('customer-shipping-country-GB').click();
  await page.getByTestId('customer-save').click();
  await expect(page.getByTestId('customer-editor')).not.toBeVisible();
};

test('a shared billing and shipping address keeps its billing when only shipping changes', async ({ page }) => {
  const { token, email, id, sharedId } = await seedSharedAddress();
  await openCustomer(page, email);
  await expect(page.getByText('Same as billing', { exact: true })).toBeVisible();
  await fillDifferentShippingAndSave(page);
  const addresses = await readAddresses(token, id);
  const shared = addresses.find((address) => address.id === sharedId);
  expect(shared).toMatchObject({ address_1: '1 Old St', city: 'London', postal_code: 'N1 1AA', country_code: 'gb',
    is_default_billing: true });
  const shipping = addresses.filter((address) => address.is_default_shipping);
  expect(shipping).toHaveLength(1);
  expect(shipping[0]).toMatchObject({ address_1: '2 Dock Rd', city: 'Hull', postal_code: 'HU1 1AA', country_code: 'gb' });
  expect(shared).toMatchObject({ is_default_shipping: false });
});

test('a shared billing and shipping address takes a billing edit and a different shipping address in one save', async ({ page }) => {
  const { token, email, id, sharedId } = await seedSharedAddress();
  await openCustomer(page, email);
  await page.getByLabel('Address line 1', { exact: true }).fill('3 New St');
  await fillDifferentShippingAndSave(page);
  const addresses = await readAddresses(token, id);
  expect(addresses.find((address) => address.id === sharedId)).toMatchObject({ address_1: '3 New St',
    is_default_billing: true, is_default_shipping: false });
  const shipping = addresses.filter((address) => address.is_default_shipping);
  expect(shipping).toHaveLength(1);
  expect(shipping[0]).toMatchObject({ address_1: '2 Dock Rd', city: 'Hull' });
  expect(addresses.filter((address) => address.id !== sharedId && address.is_default_billing)).toHaveLength(0);
});
