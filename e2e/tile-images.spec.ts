import { expect, type Page } from '@playwright/test';
import { adminToken, backend, signIn, test } from './helpers';

// The Sale's tile shows the product's Medusa image (ready item 18, AUDIT 3 · DEMO 01.3, 02a): the connector's
// getImageUrl is `thumbnail`, else the first of `images`. Playwright serves the pictures, so no request leaves
// localhost; each test puts its product back (no thumbnail, no images) and sells nothing.
const host = 'https://images.e2e.test';
const tile = (page: Page, n: number) => page.getByTestId(`product-tile-E2E product ${n}`);
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#2f7d5b"/></svg>';

async function serveImages(page: Page) {
  await page.route(`${host}/**`, route => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: svg }));
}

async function admin(method: string, route: string, body?: object) {
  const response = await fetch(`${backend}${route}`, { method, body: body && JSON.stringify(body),
    headers: { Authorization: `Bearer ${await adminToken()}`, ...(body && { 'Content-Type': 'application/json' }) } });
  expect(response.ok, await response.clone().text()).toBeTruthy();
  return response.json();
}

// Gives product n these images for the test, then takes them off and checks the admin API has none left.
async function withImages(n: number, images: { thumbnail?: string; images?: { url: string }[] }, run: (route: string) => Promise<void>) {
  const [variant] = (await admin('GET', `/admin/product-variants?limit=1&sku[]=E2E-${n}&fields=id,product_id`)).variants;
  const route = `/admin/products/${variant.product_id}`;
  try {
    await admin('POST', route, images);
    await run(route);
  } finally {
    await admin('POST', route, { thumbnail: null, images: [] });
    const { product } = await admin('GET', `${route}?fields=thumbnail,*images`);
    expect(product.thumbnail).toBeNull();
    expect(product.images).toEqual([]);
  }
}

// The tile's <img> has this URL and the browser has drawn it.
async function shows(page: Page, n: number, url: string) {
  const img = tile(page, n).locator('img');
  await expect(img).toHaveAttribute('src', url);
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete ? el.naturalWidth : 0)).toBeGreaterThan(0);
}

test('a product with a thumbnail shows it on its tile, by its name; a product with none shows no image', async ({ page }) => {
  const url = `${host}/thumb-2.svg`;
  await withImages(2, { thumbnail: url }, async () => {
    await serveImages(page);
    await signIn(page);
    await shows(page, 2, url);
    await expect(tile(page, 2)).toContainText('E2E product 2');
    await expect(tile(page, 3)).toBeVisible();
    await expect(tile(page, 3).locator('img')).toHaveCount(0);
  });
});

// Medusa fills `thumbnail` from the first image only when a product is created; an update with images leaves it null,
// which is what a merchant gets who adds images to an existing product.
test('a product with images and no thumbnail shows its first image', async ({ page }) => {
  const first = `${host}/first-3.svg`;
  await withImages(3, { images: [{ url: first }, { url: `${host}/second-3.svg` }] }, async (route) => {
    const { product } = await admin('GET', `${route}?fields=thumbnail,*images`);
    expect(product.thumbnail).toBeNull();
    expect(product.images.map((image: { url: string }) => image.url)).toEqual([first, `${host}/second-3.svg`]);
    await serveImages(page);
    await signIn(page);
    await shows(page, 3, first);
  });
});

test('an image taken off again leaves the tile with none after a sync', async ({ page }) => {
  const url = `${host}/thumb-5.svg`;
  await withImages(5, { thumbnail: url }, async (route) => {
    await serveImages(page);
    await signIn(page);
    await shows(page, 5, url);
    await admin('POST', route, { thumbnail: null, images: [] });
    await page.getByTestId('catalogue-sync').click();
    await expect(tile(page, 5).locator('img')).toHaveCount(0);
    await expect(tile(page, 5)).toContainText('E2E product 5');
  });
});
