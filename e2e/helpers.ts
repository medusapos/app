import { expect, type Page } from '@playwright/test';

const backend = process.env.E2E_BACKEND_URL ?? 'http://localhost:9100';
const credentials = { email: process.env.E2E_EMAIL ?? 'e2e@tally.test', password: process.env.E2E_PASSWORD ?? 'e2e-password' };

export async function signIn(page: Page) {
  await page.goto('/login');
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page.getByLabel('Backend URL', { exact: true })).toBeEditable();
  await expect(async () => {
    await page.getByLabel('Backend URL', { exact: true }).clear();
    await page.getByLabel('Backend URL', { exact: true }).fill(backend);
    await page.getByLabel('Email', { exact: true }).fill(credentials.email);
    await page.getByLabel('Password', { exact: true }).fill(credentials.password);
    await expect(page.getByLabel('Backend URL', { exact: true })).toHaveValue(backend, { timeout: 1000 });
    await expect(page.getByLabel('Email', { exact: true })).toHaveValue(credentials.email, { timeout: 1000 });
    await expect(page.getByLabel('Password', { exact: true })).toHaveValue(credentials.password, { timeout: 1000 });
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled({ timeout: 1000 });
  }).toPass({ timeout: 20000 });
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  if (process.env.E2E_BACKEND_URL !== undefined) {
    await expect(page.getByText(/Up to date · [\d,.  ]+ products/)).toBeVisible({ timeout: 5 * 60_000 });
  } else {
    await expect(page.getByText(/Up to date · 5 products/)).toBeVisible();
  }
}

// Numeric cash is in EUR major units. Return the displayed receipt total before New sale.
export async function sellBySku(page: Page, skus: string[], cash: 'exact' | number | 'external') {
  const search = page.getByPlaceholder('Search or scan barcode / SKU', { exact: true });
  for (const sku of skus) {
    await search.fill(sku);
    await search.press('Enter');
    await expect(search).toHaveValue('');
  }
  if (cash === 'external') {
    await page.getByRole('button', { name: 'Card terminal', exact: true }).click();
    await page.getByLabel('Terminal reference', { exact: true }).fill('e2e-offline-terminal');
    await page.getByRole('button', { name: 'Payment approved on terminal', exact: true }).click();
  } else {
    await page.getByRole('button', { name: 'Cash', exact: true }).click();
    const tender = page.getByText('Cash Tendered', { exact: true }).locator('..');
    const amount = tender.locator('input');
    if (cash === 'exact') {
      // The first quick amount is the exact total, followed by rounded amounts.
      await tender.locator('[tabindex="0"]').first().click();
      await amount.fill(await amount.inputValue());
    } else {
      await amount.fill(cash.toFixed(2));
    }
    await page.getByRole('button', { name: 'Complete sale', exact: true }).click();
  }
  const newSale = page.getByRole('button', { name: 'New sale', exact: true });
  await expect(newSale).toBeVisible();
  const receiptText = await page.getByText(/^Total: /).innerText();
  const total = Number(receiptText.replace(/[^\d.,]/g, '').replace(',', '.'));
  await newSale.click();
  return total;
}

type SalePayload = {
  clientOrderId: string; totalMinor: number;
  lines: { variantId: string; quantity: number; unitPriceMinor: number }[];
  payments: { method: string }[];
};

export function captureSales(page: Page) {
  const sales = new Map<string, SalePayload>();
  page.on('request', request => {
    if (request.method() !== 'POST' || request.url() !== `${backend}/tally/v1/commands`) return;
    for (const { payload } of request.postDataJSON().commands as { payload: SalePayload }[]) {
      sales.set(payload.clientOrderId, payload);
    }
  });
  return sales;
}

export async function adminToken(): Promise<string> {
  const response = await fetch(`${backend}/auth/user/emailpass`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials),
  });
  expect(response.ok, await response.clone().text()).toBeTruthy();
  return (await response.json()).token;
}

export type AdminOrder = {
  id: string; display_id: number; metadata: { tally_client_id?: string }; total: number;
  status: string; payment_status: string;
  payment_collections: { amount: number; status: string }[];
  items: { quantity: number; variant_id: string }[];
};

export async function ordersByClientId(token: string): Promise<AdminOrder[]> {
  const fields = 'id,display_id,metadata,total,status,payment_status,payment_collections.amount,payment_collections.status,items.quantity,items.variant_id';
  const all: AdminOrder[] = [];
  let count: number;
  do {
    const response = await fetch(`${backend}/admin/orders?limit=100&offset=${all.length}&fields=${fields}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.ok, await response.clone().text()).toBeTruthy();
    const body = await response.json();
    all.push(...body.orders);
    count = body.count;
  } while (all.length < count);
  return all.filter(order => order.metadata?.tally_client_id);
}

export async function stockBySku(token: string): Promise<Record<string, number>> {
  const skus = ['E2E-1', 'E2E-2', 'E2E-3', 'E2E-4', 'E2E-5'].map(sku => `sku[]=${sku}`).join('&');
  const response = await fetch(`${backend}/admin/inventory-items?limit=100&fields=sku,location_levels.stocked_quantity&${skus}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.ok, await response.clone().text()).toBeTruthy();
  const { inventory_items } = await response.json();
  return Object.fromEntries(inventory_items.map((item: { sku: string; location_levels: { stocked_quantity: number }[] }) =>
    [item.sku, item.location_levels.reduce((total, level) => total + Number(level.stocked_quantity), 0)]));
}
