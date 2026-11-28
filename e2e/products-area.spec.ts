import { expect, type Page } from '@playwright/test';
import { adminToken, backend, cartTab, openArea, signIn, test, variantIdBySku } from './helpers';

test('the Products area lists the catalogue read-only and finds a variant by SKU', async ({ page }) => {
  await signIn(page);
  await openArea(page, 'Products');
  await expect(page).toHaveURL(/\/products$/);
  await expect(page.getByTestId('products-admin-note')).toBeVisible();
  await expect(page.locator('[data-testid^="product-row-"]', { hasText: 'E2E product 1' }).filter({ hasText: 'E2E-1' }).first())
    .toBeVisible();
  await page.getByTestId('products-search').fill('E2E-4B');
  const rows = page.locator('[data-testid^="product-row-"]');
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: 'E2E-4B' })).toHaveCount(1);
  await expect(rows.filter({ hasText: 'E2E product 4' })).toHaveCount(1);
  await expect(page.getByTestId('products-footer')).toHaveText(/^Showing 1 of \d+$/);
});

// v2's Expanded rows: a product with several variants is one row, closed; its "2 variations" toggle shows them under it.
test('the Products area shows E2E product 4 as one row whose variations toggle opens and closes its Default and B sub-rows', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const token = await adminToken();
  const defaultId = await variantIdBySku(token, 'E2E-4');
  const bId = await variantIdBySku(token, 'E2E-4B');
  await signIn(page);
  await openArea(page, 'Products');
  const rows = page.locator('[data-testid^="product-row-"]');
  const product = rows.filter({ hasText: 'E2E product 4' });
  await expect(product).toHaveCount(1);
  await expect(product).toContainText('2 variations');
  await expect(rows.filter({ hasText: 'E2E-4B' })).toHaveCount(0);
  const toggle = page.getByRole('button', { name: '2 variations, E2E product 4', exact: true });
  // A new device is on v2's Open in place: the toggle fills the table with the product's variants under a Products back link.
  await toggle.click();
  await expect(page.getByTestId('products-place-name')).toHaveText('E2E product 4');
  await expect(page.getByTestId(`product-row-${defaultId}`)).toContainText('Default');
  await expect(page.getByTestId(`product-row-${bId}`)).toContainText('B');
  await expect(rows).toHaveCount(2);
  await expect(page.getByTestId('products-footer')).toHaveText(/^Showing 2 of 2$/);
  await page.getByTestId('products-place-back').click();
  await expect(page.getByTestId('products-place')).toHaveCount(0);
  await expect(product).toHaveCount(1);
  await expect(rows.filter({ hasText: 'E2E-4B' })).toHaveCount(0);
  // v2's Expanded rows, chosen in the settings sheet.
  await page.getByTestId('products-settings-button').click();
  await page.getByTestId('products-settings-variations-popover').click();
  await expect(page.getByTestId('products-settings-variations-popover')).toHaveAttribute('aria-selected', 'true');
  await page.getByTestId('products-settings-close').click();
  await expect(page.getByTestId('products-settings-sheet')).not.toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId(`product-row-${defaultId}`)).toContainText('Default');
  await expect(page.getByTestId(`product-row-${bId}`)).toContainText('B');
  await expect(page.getByTestId(`product-row-${bId}`)).toContainText('E2E-4B');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId(`product-row-${defaultId}`)).toHaveCount(0);
  await expect(page.getByTestId(`product-row-${bId}`)).toHaveCount(0);
});

test('the Products area narrows E2E product 4 in place by its Variant option chip, and the cross takes it off', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const bId = await variantIdBySku(await adminToken(), 'E2E-4B');
  await signIn(page);
  await openArea(page, 'Products');
  await page.getByRole('button', { name: '2 variations, E2E product 4', exact: true }).click();
  const slot = page.getByTestId('products-place-options');
  const chip = slot.getByRole('button', { name: 'Variant', exact: true });
  await expect(chip).toHaveText('Variant');
  await chip.click();
  await page.getByTestId(/^products-option-.*-value-B$/).click();
  const rows = page.locator('[data-testid^="product-row-"]');
  await expect(rows).toHaveCount(1);
  await expect(page.getByTestId(`product-row-${bId}`)).toBeVisible();
  await expect(page.getByTestId('products-footer')).toHaveText('Showing 1 of 2');
  await expect(slot.getByRole('button', { name: 'Variant: B', exact: true })).toHaveText('Variant: B');
  await slot.getByRole('button', { name: 'Remove Variant' }).click();
  await expect(rows).toHaveCount(2);
  await expect(chip).toHaveText('Variant');
});

test('the Products area narrows by category chip and shows each row\'s stock status and category', async ({ page }) => {
  await signIn(page);
  await openArea(page, 'Products');
  const categories = page.getByRole('radiogroup', { name: 'Categories' });
  const chip = (name: string) => categories.getByRole('radio', { name, exact: true });
  for (const name of ['All products', 'Drinks', 'Food']) await expect(chip(name)).toBeVisible();
  await expect(chip('All products')).toBeChecked();
  const rows = page.locator('[data-testid^="product-row-"]');
  const first = rows.filter({ hasText: 'E2E product 1' }).filter({ hasText: 'E2E-1' }).first();
  await expect(first).toContainText('Drinks');
  await expect(first.locator('[data-testid^="product-stock-status-"]')).toHaveText('In stock');
  await chip('Food').click();
  await expect(rows.filter({ hasText: 'E2E product 1' })).toHaveCount(0);
  await expect(rows.first()).toBeVisible();
  for (const row of await rows.all()) await expect(row).toContainText('E2E product 3');
  await chip('All products').click();
  await expect(first).toBeVisible();
});

test('the Products area loads the catalogue itself when opened without the Sale', async ({ page }) => {
  await signIn(page, 'Europe', false);
  // A fresh page load with the saved session: no Sale is mounted beneath the areas.
  await page.goto('/orders');
  await openArea(page, 'Products');
  await expect(page).toHaveURL(/\/products$/);
  await expect(page.locator('[data-testid^="product-row-"]', { hasText: 'E2E product 1' }).filter({ hasText: 'E2E-1' }).first())
    .toBeVisible();
  await expect(page.getByTestId('products-loading')).toHaveCount(0);
  await expect(page.getByTestId('products-error')).toHaveCount(0);
  await expect(page.getByText(/Up to date · /)).toHaveCount(0);
});

test('the Products area keeps its category across a page load and narrows with an In stock chip that it does not keep', async ({ page }) => {
  await signIn(page);
  await openArea(page, 'Products');
  const categories = page.getByRole('radiogroup', { name: 'Categories' });
  const chip = (name: string) => categories.getByRole('radio', { name, exact: true });
  const rows = page.locator('[data-testid^="product-row-"]');
  await chip('Food').click();
  await expect(chip('Food')).toBeChecked();
  // A fresh page load: the category is read back from this device's storage.
  await page.goto('/orders');
  await openArea(page, 'Products');
  await expect(chip('Food')).toBeChecked();
  await expect(rows.filter({ hasText: 'E2E product 3' }).first()).toBeVisible();
  await expect(rows.filter({ hasText: 'E2E product 1' })).toHaveCount(0);
  const inStock = page.getByRole('button', { name: 'In stock', exact: true });
  await expect(inStock).toBeVisible();
  await expect(inStock).toHaveAttribute('aria-pressed', 'false');
  await inStock.click();
  await expect(inStock).toHaveAttribute('aria-pressed', 'true');
  await expect(rows.filter({ hasText: 'E2E product 3' }).first()).toBeVisible();
  await chip('All products').click();
  await expect(chip('All products')).toBeChecked();
});

test('the Products area narrows by the Tags chip, keeps the tag across a page load, and its cross takes it off', async ({ page }) => {
  await signIn(page);
  await openArea(page, 'Products');
  const rows = page.locator('[data-testid^="product-row-"]');
  const tags = page.getByTestId('products-tags');
  await expect(tags).toHaveText('Tags');
  await tags.click();
  const menu = page.getByTestId('products-tags-menu');
  for (const name of ['Organic', 'Seasonal']) await expect(menu.getByRole('radio', { name, exact: true })).toBeVisible();
  await menu.getByRole('radio', { name: 'Organic', exact: true }).click();
  await expect(menu).toHaveCount(0);
  await expect(tags).toHaveText('Organic');
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: 'E2E product 1' })).toHaveCount(1);
  await expect(rows.filter({ hasText: 'E2E product 3' })).toHaveCount(1);
  await expect(page.getByTestId('products-footer')).toHaveText(/^Showing 2 of \d+$/);
  // A fresh page load: the tag is read back from this device's storage.
  await page.goto('/orders');
  await openArea(page, 'Products');
  await expect(tags).toHaveText('Organic');
  await expect(rows).toHaveCount(2);
  await page.getByTestId('products-tags-remove').click();
  await expect(tags).toHaveText('Tags');
  await expect(rows.filter({ hasText: 'E2E product 2' }).first()).toBeVisible();
});

// The seed puts E2E product 2 alone in the Featured collection; its title comes from the store API.
test('the Products area narrows by the Collections chip, and its cross takes it off', async ({ page }) => {
  await signIn(page);
  await openArea(page, 'Products');
  const rows = page.locator('[data-testid^="product-row-"]');
  const collections = page.getByTestId('products-collections');
  await expect(collections).toHaveText('Collections');
  await collections.click();
  const menu = page.getByTestId('products-collections-menu');
  await expect(menu.getByRole('radio', { name: 'Featured', exact: true })).toBeVisible();
  await menu.getByRole('radio', { name: 'Featured', exact: true }).click();
  await expect(menu).toHaveCount(0);
  await expect(collections).toHaveText('Featured');
  await expect(rows).toHaveCount(1);
  await expect(rows.filter({ hasText: 'E2E product 2' })).toHaveCount(1);
  await expect(page.getByTestId('products-footer')).toHaveText(/^Showing 1 of \d+$/);
  await page.getByTestId('products-collections-remove').click();
  await expect(collections).toHaveText('Collections');
  await expect(rows.filter({ hasText: 'E2E product 1' }).first()).toBeVisible();
});

test('on a phone the Products area lists two-line rows, not the table, and finds a variant by SKU', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await signIn(page);
  await openArea(page, 'Products');
  await expect(page.getByTestId('products-list')).toBeVisible();
  await expect(page.getByTestId('products-table')).toHaveCount(0);
  await expect(page.getByTestId('products-footer')).toBeVisible();
  const rows = page.locator('[data-testid^="product-list-row-"]');
  const first = rows.filter({ hasText: 'E2E product 1' }).filter({ hasText: 'E2E-1' }).first();
  await expect(first).toBeVisible();
  await expect(first.locator('[data-testid^="product-stock-status-"]')).toContainText('In stock');
  await page.getByTestId('products-search').fill('E2E-4B');
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: 'E2E-4B' })).toHaveCount(1);
  await expect(rows.filter({ hasText: 'E2E product 4' })).toHaveCount(1);
});

test('the Products area\'s settings sheet hides a column, keeps it across a page load, and restores the defaults', async ({ page }) => {
  await signIn(page);
  await openArea(page, 'Products');
  const table = page.getByTestId('products-table');
  // A head's text, past the sort arrow the sorted column carries ("Product ▲").
  const head = (name: string) => table.getByRole('columnheader').filter({ hasText: new RegExp(`^${name}( [▲▼])?$`) });
  await expect(head('SKU')).toBeVisible();
  await page.getByTestId('products-settings-button').click();
  await expect(page.getByRole('dialog').getByText('Product Settings', { exact: true })).toBeVisible();
  await page.getByTestId('products-settings-column-sku').click();
  await expect(page.getByTestId('products-settings-column-sku')).toHaveAttribute('aria-checked', 'false');
  await page.getByTestId('products-settings-close').click();
  await expect(page.getByTestId('products-settings-sheet')).not.toBeVisible();
  await expect(head('Product')).toBeVisible();
  await expect(head('SKU')).toHaveCount(0);
  // A fresh page load: the choice is read back from this device's storage.
  await page.reload();
  await expect(head('Product')).toBeVisible();
  await expect(head('SKU')).toHaveCount(0);
  await page.getByTestId('products-settings-button').click();
  await page.getByTestId('products-settings-restore').click();
  await page.getByTestId('products-settings-close').click();
  await expect(head('SKU')).toBeVisible();
});

test('the Products area\'s settings sheet shows v2\'s ID and Barcode columns, off until switched on', async ({ page }) => {
  await signIn(page);
  await openArea(page, 'Products');
  const table = page.getByTestId('products-table');
  // A head's text, past the sort arrow the sorted column carries ("Product ▲").
  const head = (name: string) => table.getByRole('columnheader').filter({ hasText: new RegExp(`^${name}( [▲▼])?$`) });
  await expect(head('Product')).toBeVisible();
  await expect(head('ID')).toHaveCount(0);
  await expect(head('Barcode')).toHaveCount(0);
  await page.getByTestId('products-settings-button').click();
  await page.getByTestId('products-settings-column-barcode').click();
  await page.getByTestId('products-settings-column-id').click();
  await expect(page.getByTestId('products-settings-column-id')).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('products-settings-close').click();
  await expect(head('Barcode')).toBeVisible();
  await expect(head('ID')).toBeVisible();
  const first = page.locator('[data-testid^="product-row-"]', { hasText: 'E2E product 1' }).filter({ hasText: 'E2E-1' }).first();
  await expect(first).toContainText('2000000000011');
  // The ID cell shows the row's own Medusa variant id.
  const id = (await first.getAttribute('data-testid'))?.replace(/^product-row-/, '') ?? '';
  expect(id).toMatch(/^variant_/);
  await expect(first).toContainText(id);
  await page.getByTestId('products-settings-button').click();
  await page.getByTestId('products-settings-restore').click();
  await page.getByTestId('products-settings-close').click();
  await expect(head('ID')).toHaveCount(0);
  await expect(head('Barcode')).toHaveCount(0);
});

test('the Products area\'s settings sheet lists v2\'s Image switch first, on, and each row shows its image tile', async ({ page }) => {
  await signIn(page);
  await openArea(page, 'Products');
  const table = page.getByTestId('products-table');
  const first = table.locator('[data-testid^="product-row-"]', { hasText: 'E2E product 1' }).filter({ hasText: 'E2E-1' }).first();
  await expect(first).toBeVisible();
  const id = (await first.getAttribute('data-testid'))?.replace(/^product-row-/, '') ?? '';
  // The e2e products have no thumbnail, so each row shows the plain tile.
  await expect(first.getByTestId(`product-image-placeholder-${id}`)).toBeVisible();
  await page.getByTestId('products-settings-button').click();
  const image = page.getByTestId('products-settings-column-image');
  await expect(page.locator('[data-testid^="products-settings-column-"]').first())
    .toHaveAttribute('data-testid', 'products-settings-column-image');
  await expect(image).toHaveAttribute('aria-checked', 'true');
  await image.click();
  await expect(image).toHaveAttribute('aria-checked', 'false');
  await page.getByTestId('products-settings-close').click();
  await expect(first).toBeVisible();
  await expect(table.locator('[data-testid^="product-image-"]')).toHaveCount(0);
  await page.getByTestId('products-settings-button').click();
  await page.getByTestId('products-settings-restore').click();
  await page.getByTestId('products-settings-close').click();
  await expect(first.getByTestId(`product-image-placeholder-${id}`)).toBeVisible();
});

test('the Products area\'s settings switches show whole inside the sheet at 1280 wide', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await signIn(page);
  await openArea(page, 'Products');
  await page.getByTestId('products-settings-button').click();
  const sheet = page.getByTestId('products-settings-sheet');
  const root = (id: string) => page.getByTestId(`products-settings-column-${id}`);
  const box = async (id: string) => {
    const r = await root(id).boundingBox();
    const t = await root(id).locator('> *').first().boundingBox();
    if (!r || !t) throw new Error(`no box for ${id}`);
    return { r, t, inside: t.x >= r.x - 0.5 && t.x + t.width <= r.x + r.width + 0.5, offset: t.x + t.width / 2 - (r.x + r.width / 2) };
  };
  for (const id of ['id', 'barcode']) {
    await root(id).click();
    await expect(root(id)).toHaveAttribute('aria-checked', 'true');
  }
  const ids = ['id', 'sku', 'barcode', 'stock', 'stockStatus', 'category', 'price'];
  await expect(async () => {
    const s = await sheet.boundingBox();
    if (!s) throw new Error('no sheet box');
    for (const id of ids) {
      const { r, t, inside, offset } = await box(id);
      console.log(`switch ${id}: root ${r.x}-${r.x + r.width}, thumb ${t.x}-${t.x + t.width}, sheet ${s.x}-${s.x + s.width}`);
      expect(inside, `${id} thumb inside its root`).toBe(true);
      expect(offset, `${id} thumb centre right of the root centre`).toBeGreaterThan(0);
      expect(r.x + r.width, `${id} root inside the sheet's padding`).toBeLessThanOrEqual(s.x + s.width - 24 + 0.5);
    }
  }).toPass();
  await root('id').click();
  await expect(root('id')).toHaveAttribute('aria-checked', 'false');
  await expect(async () => {
    const { r, t, inside, offset } = await box('id');
    console.log(`switch id off: root ${r.x}-${r.x + r.width}, thumb ${t.x}-${t.x + t.width}`);
    expect(inside, 'id thumb inside its root').toBe(true);
    expect(offset, 'id thumb centre left of the root centre').toBeLessThan(0);
  }).toPass();
  await page.getByTestId('products-settings-restore').click();
  await page.getByTestId('products-settings-close').click();
});

test('the Products area\'s Regular price and Sale price columns grey a sale variant\'s regular price beside its sale price', async ({ page }) => {
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
    await openArea(page, 'Products');
    const table = page.getByTestId('products-table');
    // A head's text, past the sort arrow the sorted column carries ("Product ▲").
    const head = (name: string) => table.getByRole('columnheader').filter({ hasText: new RegExp(`^${name}( [▲▼])?$`) });
    await expect(head('Product')).toBeVisible();
    await expect(head('Regular price')).toHaveCount(0);
    await expect(head('Sale price')).toHaveCount(0);
    await page.getByTestId('products-settings-button').click();
    await page.getByTestId('products-settings-column-regularPrice').click();
    await page.getByTestId('products-settings-column-salePrice').click();
    await expect(page.getByTestId('products-settings-column-salePrice')).toHaveAttribute('aria-checked', 'true');
    await page.getByTestId('products-settings-close').click();
    await expect(head('Regular price')).toBeVisible();
    await expect(head('Sale price')).toBeVisible();
    // E2E product 3 is on sale at €3.00: its €4.25 regular price is greyed, as v2's demo, not struck through.
    await expect(page.getByTestId(`product-sale-price-${variantId}`)).toHaveText('€3.00');
    const saleRegular = page.getByTestId(`product-regular-price-${variantId}`);
    await expect(saleRegular).toHaveText('€4.25');
    // E2E product 1 has no sale: its regular price stands and its sale cell is empty.
    const first = page.locator('[data-testid^="product-row-"]', { hasText: 'E2E product 1' }).filter({ hasText: 'E2E-1' }).first();
    const regular = first.locator('[data-testid^="product-regular-price-"]');
    await expect(regular).toHaveText('€2.00');
    await expect(saleRegular).not.toHaveCSS('text-decoration-line', /line-through/);
    const colour = (cell: typeof regular) => cell.evaluate((el) => getComputedStyle(el).color);
    expect(await colour(saleRegular)).not.toBe(await colour(regular));
    await expect(first.locator('[data-testid^="product-sale-price-"]')).toHaveText('');
    await page.getByTestId('products-settings-button').click();
    await page.getByTestId('products-settings-restore').click();
    await page.getByTestId('products-settings-close').click();
    await expect(head('Regular price')).toHaveCount(0);
    await expect(head('Sale price')).toHaveCount(0);
  } finally {
    const removed = await fetch(`${backend}/admin/price-lists/${priceListId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    expect(removed.ok, await removed.clone().text()).toBeTruthy();
  }
});

test('the Products area\'s On sale chip narrows the rows to a variant on a Medusa sale price list, and back', async ({ page }) => {
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
    await openArea(page, 'Products');
    const rows = page.locator('[data-testid^="product-row-"]');
    const first = rows.filter({ hasText: 'E2E product 1' }).filter({ hasText: 'E2E-1' }).first();
    await expect(first).toBeVisible();
    const onSale = page.getByRole('button', { name: 'On sale', exact: true });
    await expect(onSale).toHaveAttribute('aria-pressed', 'false');
    await onSale.click();
    await expect(onSale).toHaveAttribute('aria-pressed', 'true');
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText('E2E product 3');
    await expect(rows).toContainText('E2E-3');
    await expect(first).toHaveCount(0);
    await expect(page.getByTestId('products-footer')).toHaveText(/^Showing 1 of \d+$/);
    await onSale.click();
    await expect(onSale).toHaveAttribute('aria-pressed', 'false');
    await expect(first).toBeVisible();
  } finally {
    const removed = await fetch(`${backend}/admin/price-lists/${priceListId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    expect(removed.ok, await removed.clone().text()).toBeTruthy();
  }
});

// Settings › Barcode Scanning: save prefix # and suffix !, turn Play a sound on scan on, then open Products.
async function openProductsWithScanAffixes(page: Page) {
  const phone = (page.viewportSize()?.width ?? 1280) < 768;
  await openArea(page, 'Settings');
  await page.getByTestId(phone ? 'settings-list-scanner' : 'settings-nav-scanner').click();
  await page.getByLabel('Scanner prefix', { exact: true }).fill('#');
  await page.getByLabel('Scanner suffix', { exact: true }).fill('!');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const sound = page.getByRole('switch', { name: 'Play a sound on scan' });
  await sound.click();
  await expect(sound).toBeChecked();
  // A phone's section page has a back button, not the Menu: back to the list first.
  if (phone) {
    await page.goBack();
    await expect(page.getByTestId('settings-list')).toBeVisible();
  }
  await openArea(page, 'Products');
}

// v2: "On the Products and Orders screens, a scan goes into that screen's search box instead".
test('a barcode scan into the Products search, or with nothing focused, becomes the search without its affixes', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await signIn(page);
  await openProductsWithScanAffixes(page);
  const search = page.getByTestId('products-search');
  const rows = page.locator('[data-testid^="product-row-"]');
  await search.click();
  await search.pressSequentially('#2000000000011!', { delay: 10 });
  await search.press('Enter');
  await expect(search).toHaveValue('2000000000011');
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('E2E product 1');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.type('#E2E-4B!', { delay: 10 });
  await page.keyboard.press('Enter');
  await expect(search).toHaveValue('E2E-4B');
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: 'E2E-4B' })).toHaveCount(1);
  await expect(rows.filter({ hasText: 'E2E product 4' })).toHaveCount(1);
  // Ordinary typing still searches (each term on its own, so "2" also matches the other E2E names).
  await search.fill('E2E product 2');
  await expect(search).toHaveValue('E2E product 2');
  await expect(rows.filter({ hasText: 'E2E product 2' }).first()).toBeVisible();
});

test('on a phone a barcode scan into the Products search filters the list and adds nothing to the cart', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await openProductsWithScanAffixes(page);
  const search = page.getByTestId('products-search');
  const rows = page.locator('[data-testid^="product-list-row-"]');
  await search.click();
  await search.pressSequentially('#2000000000011!', { delay: 10 });
  await search.press('Enter');
  await expect(search).toHaveValue('2000000000011');
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('E2E product 1');
  await openArea(page, 'POS');
  await expect(cartTab(page)).toHaveAccessibleName('Cart, New');
});

test('the Products area\'s Type column and Product SKU and Attributes lines show a Medusa product type and a variant\'s options', async ({ page }) => {
  const token = await adminToken();
  const json = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const created = await fetch(`${backend}/admin/product-types`, { method: 'POST', headers: json,
    body: JSON.stringify({ value: 'E2E Apparel' }) });
  expect(created.ok, await created.clone().text()).toBeTruthy();
  const typeId: string = (await created.json()).product_type.id;
  const found = await fetch(`${backend}/admin/products?title=${encodeURIComponent('E2E product 4')}&fields=id,type_id`, { headers: json });
  expect(found.ok, await found.clone().text()).toBeTruthy();
  const [product] = (await found.json()).products as { id: string; type_id: string | null }[];
  const setType = (value: string | null) => fetch(`${backend}/admin/products/${product.id}`,
    { method: 'POST', headers: json, body: JSON.stringify({ type_id: value }) });
  const typed = await setType(typeId);
  try {
    expect(typed.ok, await typed.clone().text()).toBeTruthy();
    const bId = await variantIdBySku(token, 'E2E-4B');
    const firstId = await variantIdBySku(token, 'E2E-1');
    await signIn(page);
    await openArea(page, 'Products');
    const table = page.getByTestId('products-table');
    // A head's text, past the sort arrow the sorted column carries ("Product ▲").
    const head = (name: string) => table.getByRole('columnheader').filter({ hasText: new RegExp(`^${name}( [▲▼])?$`) });
    await expect(head('Product')).toBeVisible();
    await expect(head('Type')).toHaveCount(0);
    await page.getByTestId('products-settings-button').click();
    await expect(page.getByTestId('products-settings-product')).toHaveText('Product');
    await page.getByTestId('products-settings-column-type').click();
    await page.getByTestId('products-settings-product-sku').click();
    await page.getByTestId('products-settings-product-attributes').click();
    await expect(page.getByTestId('products-settings-product-attributes')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('products-settings-product-barcode')).toHaveAttribute('aria-checked', 'false');
    // The sub-rows below are v2's Expanded rows (a new device is on Open in place).
    await page.getByTestId('products-settings-variations-popover').click();
    await page.getByTestId('products-settings-close').click();
    await expect(head('Type')).toBeVisible();
    await expect(page.getByTestId(`product-type-${product.id}`)).toHaveText('E2E Apparel');
    await page.getByRole('button', { name: '2 variations, E2E product 4', exact: true }).click();
    await expect(page.getByTestId(`product-type-${bId}`)).toHaveText('E2E Apparel');
    await expect(page.getByTestId(`product-line-sku-${bId}`)).toHaveText('E2E-4B');
    await expect(page.getByTestId(`product-line-attributes-${bId}`)).toHaveText('Variant: B');
    await expect(page.getByTestId(`product-line-barcode-${bId}`)).toHaveCount(0);
    // E2E product 1 has no type: an empty Type cell, and its one variant's option on its attributes line.
    await expect(page.getByTestId(`product-type-${firstId}`)).toHaveText('');
    await expect(page.getByTestId(`product-line-attributes-${firstId}`)).toHaveText('Variant: Default');
    await page.getByTestId('products-settings-button').click();
    await page.getByTestId('products-settings-restore').click();
    await page.getByTestId('products-settings-close').click();
    await expect(head('Type')).toHaveCount(0);
    await expect(page.getByTestId(`product-line-sku-${bId}`)).toHaveCount(0);
  } finally {
    const restored = await setType(product.type_id);
    expect(restored.ok, await restored.clone().text()).toBeTruthy();
    const removed = await fetch(`${backend}/admin/product-types/${typeId}`, { method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` } });
    expect(removed.ok, await removed.clone().text()).toBeTruthy();
  }
});

// v2's Columns rows start with a drag handle: dragging Price above SKU moves its column, kept across a load until Restore.
test('the Products area\'s settings sheet drags the Price row above SKU, moving its column, and Restore puts it back', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await signIn(page);
  await openArea(page, 'Products');
  const table = page.getByTestId('products-table');
  // The visible heads in table order, past the sort arrow the sorted column carries ("Product ▲").
  const heads = async () => (await table.getByRole('columnheader').allTextContents()).map((text) => text.replace(/ [▲▼]$/, ''));
  const before = (first: string, second: string) => async () => {
    const order = await heads();
    return order.includes(first) && order.includes(second) && order.indexOf(first) < order.indexOf(second);
  };
  await expect.poll(before('SKU', 'Price')).toBe(true);
  await page.getByTestId('products-settings-button').click();
  const price = page.getByTestId('products-settings-drag-price');
  const sku = page.getByTestId('products-settings-drag-sku');
  // A touch drag on a handle moves the row, not the sheet.
  await expect(price).toHaveCSS('touch-action', 'none');
  await price.scrollIntoViewIfNeeded();
  const from = await price.boundingBox();
  const to = await sku.boundingBox();
  if (!from || !to) throw new Error('drag handles not laid out');
  // Price's centre to just inside SKU's top: above SKU's centre, below Type's.
  const x = from.x + from.width / 2;
  await page.mouse.move(x, from.y + from.height / 2);
  await page.mouse.down();
  const targetY = to.y + to.height / 4;
  for (let step = 1; step <= 10; step += 1) await page.mouse.move(x, from.y + from.height / 2 + (targetY - from.y - from.height / 2) * step / 10);
  await page.mouse.up();
  const rows = page.getByTestId('products-settings-sheet').locator('[data-testid^="products-settings-drag-"]');
  const ids = async () => (await rows.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid'))))
    .map((id) => id?.replace('products-settings-drag-', ''));
  await expect.poll(ids).toEqual(['image', 'id', 'name', 'type', 'price', 'sku', 'barcode', 'stock', 'stockStatus', 'category', 'regularPrice',
    'salePrice']);
  await page.getByTestId('products-settings-close').click();
  await expect(page.getByTestId('products-settings-sheet')).not.toBeVisible();
  await expect.poll(before('Price', 'SKU')).toBe(true);
  // A fresh page load: the order is read back from this device's storage.
  await page.reload();
  await expect(table).toBeVisible();
  await expect.poll(before('Price', 'SKU')).toBe(true);
  await page.getByTestId('products-settings-button').click();
  await page.getByTestId('products-settings-restore').click();
  await page.getByTestId('products-settings-close').click();
  await expect.poll(before('SKU', 'Price')).toBe(true);
});
