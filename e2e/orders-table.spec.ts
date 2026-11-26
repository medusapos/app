import { expect } from '@playwright/test';
import { adminToken, backend, captureCommands, createStoreOnlyOrder, inventoryLevel, openArea, ordersByClientId, sellBySku,
  setInventoryLevel, signIn, test, type PostedCommand } from './helpers';

// v2's Orders table (DEMO row 10): the Billing Address column, read from each row's Medusa order, and the day headers
// between rows. Sells only E2E-3, which no other spec counts on, and gives its stock back after.
type Sale = { clientOrderId: string };
const WEB_BILLING = { first_name: 'Web', last_name: 'Shopper', address_1: 'Vesterbrogade 12', city: 'Copenhagen',
  postal_code: '1620', country_code: 'dk' };

let token: string;
let level: Awaited<ReturnType<typeof inventoryLevel>>;
let commands: PostedCommand<Sale>[];
test.beforeEach(async ({ page }) => {
  token = await adminToken();
  level = await inventoryLevel(token, 'E2E-3');
  commands = captureCommands<Sale>(page);
});
test.afterEach(async () => {
  try {
    await expect.poll(() => commands.every(({ status }) => status === 'applied')).toBe(true);
  } finally {
    await setInventoryLevel(token, level.inventoryItemId, level.locationId, level.stockedQuantity);
  }
});

// The store order's billing address as the cell writes it: street, city, province, postcode, upper-case country.
async function medusaBillingText(orderId: string): Promise<string> {
  const fields = 'id,billing_address.address_1,billing_address.address_2,billing_address.city,billing_address.province,'
    + 'billing_address.postal_code,billing_address.country_code';
  const response = await fetch(`${backend}/admin/orders/${orderId}?fields=${fields}`, { headers: { Authorization: `Bearer ${token}` } });
  expect(response.ok, await response.clone().text()).toBeTruthy();
  const { order } = await response.json();
  const address = order.billing_address ?? {};
  return [address.address_1, address.address_2, address.city, address.province, address.postal_code,
    address.country_code?.toUpperCase()].map((part) => part?.trim() ?? '').filter((part) => part !== '').join(', ');
}

test('each row shows its Medusa order\'s billing address, under one Today header', async ({ page }) => {
  const web = await createStoreOnlyOrder(token, 'E2E-3', `web-${crypto.randomUUID()}@example.com`, WEB_BILLING);
  await signIn(page);
  await sellBySku(page, ['E2E-3'], 'exact');
  await expect.poll(() => commands.length > 0 && commands.every(({ status }) => status === 'applied'), { timeout: 30_000 }).toBe(true);
  const clientId = commands[0]!.payload.clientOrderId;
  const sale = (await ordersByClientId(token)).find((order) => order.metadata.tally_client_id === clientId);
  expect(sale).toBeDefined();
  // A till's sale carries the stock location's address as its billing address (the plugin's own rule).
  const saleBilling = await medusaBillingText(sale!.id);
  expect(saleBilling).not.toBe('');

  await openArea(page, 'Orders');
  const table = page.getByTestId('orders-table');
  await expect(table.getByTestId(`orders-row-${web.id}-billing`)).toHaveText('Vesterbrogade 12, Copenhagen, 1620, DK');
  await expect(table.getByTestId(`orders-row-${clientId}-billing`)).toHaveText(saleBilling);

  // One header for today, the device's own calendar day, and it is the last header above each of the two rows.
  const today = await page.evaluate(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  });
  const header = table.getByTestId(`orders-row-day-${today}`);
  await expect(header).toHaveCount(1);
  await expect(header).toHaveText('Today');
  await expect(header.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
  const headersAbove = await table.evaluate((root, ids) => {
    const marks = [...root.querySelectorAll('[data-testid]')]
      .map((element) => element.getAttribute('data-testid') ?? '');
    return ids.map((id) => marks.slice(0, marks.indexOf(id)).filter((mark) => mark.startsWith('orders-row-day-')).at(-1));
  }, [`orders-row-${web.id}`, `orders-row-${clientId}`]);
  expect(headersAbove).toEqual([`orders-row-day-${today}`, `orders-row-day-${today}`]);
});

// Row 10.5: below 600 px the rows are two lines (number and total, then status, customer and date), not the 1160 px table.
test('Orders on a phone opens on number, customer and total without scrolling sideways', async ({ page }) => {
  await signIn(page);
  await sellBySku(page, ['E2E-3'], 'exact');
  await expect.poll(() => commands.length > 0 && commands.every(({ status }) => status === 'applied'), { timeout: 30_000 }).toBe(true);
  const clientId = commands[0]!.payload.clientOrderId;

  const viewport = { width: 390, height: 844 };
  await page.setViewportSize(viewport);
  await openArea(page, 'Orders');
  const row = page.getByTestId('orders-table').getByTestId(`orders-row-${clientId}`);
  await expect(row).toBeVisible();
  for (const name of ['number', 'total', 'customer']) {
    const text = row.getByTestId(`orders-row-${clientId}-${name}`);
    await expect(text).not.toHaveText('');
    const box = (await text.boundingBox())!;
    expect(box.x, `${name} starts on screen`).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, `${name} ends on screen`).toBeLessThanOrEqual(viewport.width);
  }
  // The proof: the list itself fits the phone (main's was the 1160 px table inside a sideways ScrollView).
  const list = (await page.getByTestId('orders-table').boundingBox())!;
  expect(list.width, 'the orders list fits the phone').toBeLessThanOrEqual(viewport.width);
  const widths = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, viewport: window.innerWidth }));
  expect(widths.page).toBeLessThanOrEqual(widths.viewport);

  await row.getByRole('button', { name: /^Open order / }).click();
  await expect(page.getByTestId('order-detail-sheet')).toBeVisible();
});
