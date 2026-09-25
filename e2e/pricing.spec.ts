import { expect, test, type Page } from '@playwright/test';
import { adminToken, captureSales, chooseRegion, ordersByClientId, sellBySku, signIn } from './helpers';
import { E2E_RUN } from './ports';

// TallyUI store settings (TV4) and priced replication (D2b) against the seeded store: regions
// Europe (dk, exclusive) and Germany (de, inclusive), no default region, the stock location in
// Copenhagen (dk), one publishable key for the E2E channel, and E2E-U in no channel.
const backend = process.env.E2E_BACKEND_URL ?? `http://localhost:${E2E_RUN.backendPort}`;
const setUp = (page: Page) => page.getByText('Set up this till', { exact: true });
const tile = (page: Page) => page.getByTestId('product-tile-E2E product 1');

// E2E-1's price as Medusa's store API calculates it in `region`, with the publishable key,
// formatted in the browser the way the catalogue formats it (Intl, the page's locale).
async function storePriceLabel(page: Page, token: string, region: string): Promise<string> {
  const admin = { headers: { Authorization: `Bearer ${token}` } };
  const { regions } = await (await fetch(`${backend}/admin/regions?limit=100&fields=id,name`, admin)).json();
  const regionId = regions.find((entry: { name: string }) => entry.name === region).id;
  const { api_keys } = await (await fetch(`${backend}/admin/api-keys?type=publishable&fields=token,revoked_at`, admin)).json();
  const key = api_keys.find((entry: { revoked_at: string | null }) => !entry.revoked_at).token;
  const response = await fetch(`${backend}/store/products?region_id=${regionId}&limit=100&fields=id,variants.sku,*variants.calculated_price`,
    { headers: { 'x-publishable-api-key': key } });
  expect(response.ok, await response.clone().text()).toBeTruthy();
  const { products } = await response.json();
  const variant = products.flatMap((product: { variants: unknown[] }) => product.variants)
    .find((entry: { sku: string }) => entry.sku === 'E2E-1');
  const amount: number = variant.calculated_price.calculated_amount;
  return page.evaluate((major) => new Intl.NumberFormat(undefined, { style: 'currency', currency: 'EUR' }).format(major), amount);
}

test('a fresh till chooses its region; Germany does not cover the Copenhagen location (D1)', async ({ page }) => {
  expect(await signIn(page, null)).toBe(true);
  await expect(page.getByRole('radio', { name: 'Europe', exact: true })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Germany', exact: true })).toBeVisible();
  await expect(page.getByText('Country', { exact: true })).toHaveCount(0);
  await chooseRegion(page, 'Germany');
  await expect(page.getByText('Stock location Copenhagen is in DK, which region Germany does not cover.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Choose another region', exact: true }).click();
  await expect(setUp(page)).toBeVisible();
  await chooseRegion(page, 'Europe');
  await expect(page.getByText(/Up to date · 5 products/)).toBeVisible();
});

test('the catalogue shows E2E-1 at Medusa\'s calculated price for Europe', async ({ page }) => {
  const token = await adminToken();
  await signIn(page);
  await expect(tile(page)).toContainText(await storePriceLabel(page, token, 'Europe'));
});

test('an exclusive sale of E2E-1 is applied with no warnings and the till\'s total', async ({ page }) => {
  const token = await adminToken();
  const sales = captureSales(page);
  await signIn(page);
  const applied = page.waitForResponse(async (response) => {
    if (response.request().method() !== 'POST' || response.url() !== `${backend}/tally/v1/commands`) return false;
    return ((await response.json()).results ?? []).some((result: { status: string }) => result.status === 'applied');
  });
  const receiptTotal = await sellBySku(page, ['E2E-1'], 'exact');
  const { results } = await (await applied).json();
  expect(results).toHaveLength(1);
  expect(results[0].status).toBe('applied');
  expect(results[0].warnings).toBeUndefined();
  expect(receiptTotal).toBe(2.5); // 2.00 + 25% Danish VAT: Europe's prices exclude tax
  const orders = (await ordersByClientId(token)).filter((order) => sales.has(order.metadata.tally_client_id!));
  expect(orders).toHaveLength(1);
  expect(orders[0].total).toBe(receiptTotal);
});

test('an unlisted product stays hidden', async ({ page }) => {
  await signIn(page);
  const search = page.getByPlaceholder('Search or scan barcode / SKU', { exact: true });
  await search.fill('E2E-U');
  await expect(page.getByText('No products match "E2E-U".', { exact: true })).toBeVisible();
  await expect(page.getByText(/Up to date · 5 products · 0 matching/)).toBeVisible();
  await search.press('Enter');
  await expect(search).toHaveValue('E2E-U');
});

test('the choice survives a reload', async ({ page }) => {
  const token = await adminToken();
  await signIn(page);
  await page.reload();
  await expect(page.getByText(/Up to date · 5 products/)).toBeVisible();
  await expect(setUp(page)).toHaveCount(0);
  await expect(tile(page)).toContainText(await storePriceLabel(page, token, 'Europe'));
});
