import { expect, test, type Page } from '@playwright/test';
import { adminToken, captureSales, chooseRegion, ordersByClientId, sellBySku, signIn } from './helpers';
import { E2E_RUN } from './ports';

// TallyUI store settings (TV4) and priced replication (D2b) against the seeded store: regions
// Europe (dk, exclusive) and Germany (de, inclusive), no default region, the stock location in
// Copenhagen (dk), one publishable key for the E2E channel, and E2E-U only in another channel.
// (Medusa 2.21.0 applies the store API's channel filter only with more than one sales channel.)
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
  await expect(page.getByText(/Up to date · 5 products · 1 not sold in this channel · 0 matching/)).toBeVisible();
  await search.press('Enter');
  await expect(search).toHaveValue('E2E-U');
});

// A new pricing context is a new product cache and a pull from no checkpoint. Germany gets its own
// E2E-1 price before the till syncs Europe, so a pull resumed from Europe's checkpoint would find
// nothing changed and keep showing Europe's price. The location moves to de for the switch, and back.
test('a region change resyncs the catalogue at the new region\'s price', async ({ page }) => {
  const token = await adminToken();
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  const get = async (path: string) => (await fetch(`${backend}${path}`, { headers })).json();
  const post = (path: string, body: unknown) => fetch(`${backend}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const { regions } = await get('/admin/regions?limit=100&fields=id,name');
  const germany: string = regions.find((entry: { name: string }) => entry.name === 'Germany').id;
  const { variants: [variant] } = await get('/admin/product-variants?limit=1&sku[]=E2E-1&fields=id,product_id');
  const { stock_locations: [location] } = await get('/admin/stock-locations?limit=1&name=Copenhagen&fields=id,address.*');
  const { address_1, city, postal_code } = location.address;
  const setPrices = (prices: unknown[]) => post(`/admin/products/${variant.product_id}/variants/${variant.id}`, { prices });
  const moveTo = (country_code: string) => post(`/admin/stock-locations/${location.id}`, { address: { address_1, city, postal_code, country_code } });
  try {
    const priced = await setPrices([{ currency_code: 'eur', amount: 2 }, { currency_code: 'eur', amount: 3, rules: { region_id: germany } }]);
    expect(priced.ok, await priced.clone().text()).toBeTruthy();
    await signIn(page);
    const [europePrice, germanyPrice] = [await storePriceLabel(page, token, 'Europe'), await storePriceLabel(page, token, 'Germany')];
    expect(germanyPrice).not.toBe(europePrice);
    await expect(tile(page)).toContainText(europePrice);
    const moved = await moveTo('de');
    expect(moved.ok, await moved.clone().text()).toBeTruthy();
    // Without the cached app settings, the reload reads the moved location before resolving the region.
    await page.evaluate((key) => localStorage.removeItem(key), `medusapos.settings.${backend}`);
    await page.reload();
    await page.getByRole('button', { name: 'Choose another region', exact: true }).click();
    await chooseRegion(page, 'Germany');
    await expect(page.getByText(/Up to date · 5 products/)).toBeVisible();
    await expect(tile(page)).toContainText(germanyPrice);
    // The calculated-price runner's start pass (D2b): E2E-U is replicated but not in the key's channel.
    await expect(page.getByText(/Up to date · 5 products · 1 not sold in this channel/)).toBeVisible();
  } finally {
    expect((await moveTo('dk')).ok).toBeTruthy();
    expect((await setPrices([{ currency_code: 'eur', amount: 2 }])).ok).toBeTruthy();
  }
});

test('the choice survives a reload', async ({ page }) => {
  const token = await adminToken();
  await signIn(page);
  await page.reload();
  await expect(page.getByText(/Up to date · 5 products/)).toBeVisible();
  await expect(setUp(page)).toHaveCount(0);
  await expect(tile(page)).toContainText(await storePriceLabel(page, token, 'Europe'));
});
