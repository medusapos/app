import { expect, type Page } from '@playwright/test';
import { adminToken, backend, cartLineQuantity, signIn, test, variantIdBySku } from './helpers';

// v2's pills beside In Stock, Medusa's way (ready item 17, AUDIT 3 · DEMO 02a): On Sale, Tag and Collection narrow the
// Sale's grid by sale price lists, product tags and product collections. The seed tags products 1 and 3 Organic and puts
// product 2 in the Featured collection. Picks are kept in this browser context's storage only, so none reaches another
// spec; nothing here sells, so E2E-1's shared stock is untouched.
const tiles = (page: Page) => page.getByTestId(/^product-tile-/);
const tile = (page: Page, n: number) => page.getByTestId(`product-tile-E2E product ${n}`);
async function pick(page: Page, chip: string, label: string) {
  await page.getByTestId(chip).click();
  await page.getByTestId(`${chip}-menu`).getByText(label, { exact: true }).click();
  await expect(page.getByTestId(chip)).toHaveText(label);
}

test('Tag → Organic leaves products 1 and 3, kept across a page load; its cross brings back all 5', async ({ page }) => {
  await signIn(page);
  await expect(tiles(page)).toHaveCount(5);
  await pick(page, 'filter-chip-tag', 'Organic');
  await expect(tiles(page)).toHaveCount(2);
  await expect(tile(page, 1)).toBeVisible();
  await expect(tile(page, 3)).toBeVisible();
  await page.reload();
  await expect(page.getByText(/Up to date · 5 products/)).toBeVisible();
  await expect(page.getByTestId('filter-chip-tag')).toHaveText('Organic');
  await expect(tiles(page)).toHaveCount(2);
  await page.getByTestId('filter-chip-tag-remove').click();
  await expect(page.getByTestId('filter-chip-tag')).toHaveText('Tag');
  await expect(tiles(page)).toHaveCount(5);
});

test('Collection → Featured leaves product 2', async ({ page }) => {
  await signIn(page);
  await pick(page, 'filter-chip-group-collection', 'Featured');
  await expect(tiles(page)).toHaveCount(1);
  await expect(tile(page, 2)).toBeVisible();
  await page.getByTestId('filter-chip-group-collection-remove').click();
  await expect(tiles(page)).toHaveCount(5);
});

test('with a sale price list on E2E-3, On Sale leaves product 3', async ({ page }) => {
  const token = await adminToken();
  const variantId = await variantIdBySku(token, 'E2E-3');
  const created = await fetch(`${backend}/admin/price-lists`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'E2E sale', description: 'E2E sale', type: 'sale', status: 'active',
      prices: [{ variant_id: variantId, currency_code: 'eur', amount: 3 }] }),
  });
  expect(created.ok, await created.clone().text()).toBeTruthy();
  const priceListId: string = (await created.json()).price_list.id;
  try {
    await signIn(page);
    const onSale = page.getByTestId('filter-chip-onSale');
    await expect(onSale).toHaveAttribute('aria-pressed', 'false');
    await onSale.click();
    await expect(onSale).toHaveAttribute('aria-pressed', 'true');
    await expect(tiles(page)).toHaveCount(1);
    await expect(tile(page, 3)).toBeVisible();
    await onSale.click();
    await expect(tiles(page)).toHaveCount(5);
  } finally {
    const removed = await fetch(`${backend}/admin/price-lists/${priceListId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    expect(removed.ok, await removed.clone().text()).toBeTruthy();
  }
});

test('with Organic on, a wedge scan of E2E-2 adds it to the cart and the grid stays at 2', async ({ page }) => {
  await signIn(page);
  await pick(page, 'filter-chip-tag', 'Organic');
  await expect(tiles(page)).toHaveCount(2);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.type('E2E-2', { delay: 10 });
  await page.keyboard.press('Enter');
  await expect(cartLineQuantity(page, 'E2E product 2')).toHaveText('1');
  await expect(tiles(page)).toHaveCount(2);
  await expect(tile(page, 2)).toHaveCount(0);
});
