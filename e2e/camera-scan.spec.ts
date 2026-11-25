import { expect, type Page } from '@playwright/test';
import { cameraStub } from './capture/rows';
import { cartLineQuantity, openArea, openRegisterPanel, signIn, test } from './helpers';

// v2's camera scan (AUDIT 25, DEMO 15f.5), web only: Settings › Barcode Scanning › Use camera (off by default) draws
// TU's camera button beside the Sale's search; its inline scanner's decodes go through useCameraScan's continuous
// session to the scan hub, which the Sale already hears, so a decode adds like any scan. The camera and
// BarcodeDetector are stubbed (cameraStub). Each test has its own browser context, so the setting never reaches another
// spec. Never sells: E2E product 2 (barcode 2000000000022, seed-e2e.ts) only goes into an open cart.
test.use({ viewport: { width: 1280, height: 800 } });

const E2E2_BARCODE = '2000000000022';
const button = (page: Page) => page.getByTestId('camera-scan-button');
const panel = (page: Page) => page.getByTestId('camera-scanner-panel');
const e2e2Lines = (page: Page) => page.getByRole('button', { name: 'Edit quantity of E2E product 2', exact: true });

async function shot(page: Page, state: string) {
  await test.info().attach(`${state}.png`, { body: await page.screenshot(), contentType: 'image/png' });
}

async function turnCameraOn(page: Page) {
  await openArea(page, 'Settings');
  await page.getByTestId('settings-nav-scanner').click();
  const camera = page.getByRole('switch', { name: 'Use camera to scan barcodes' });
  await expect(camera).toHaveAttribute('aria-checked', 'false');
  await camera.click();
  await expect(camera).toHaveAttribute('aria-checked', 'true');
}

test('the camera scan button is off by default', async ({ page }) => {
  await page.addInitScript(cameraStub, { code: E2E2_BARCODE, denied: false });
  await signIn(page);
  await expect(page.getByRole('searchbox')).toBeVisible();
  await expect(button(page)).toHaveCount(0);
});

test('Use camera shows the camera button; one decode resting in view adds one line, with the scan toast', async ({ page }) => {
  await page.addInitScript(cameraStub, { code: E2E2_BARCODE, denied: false });
  await signIn(page);
  await turnCameraOn(page);
  await shot(page, 'scanner-camera-setting');

  await openArea(page, 'POS');
  await expect(button(page)).toBeVisible();
  await button(page).click();
  await expect(panel(page)).toBeVisible();
  await expect(page.getByTestId('cart-empty')).toBeVisible();
  await shot(page, 'camera-scanner-open');

  // The detector keeps seeing the code (every 200 ms) until the flag clears: the session's cooldown holds it to one add.
  await page.evaluate(() => { (window as unknown as { __cameraCode: boolean }).__cameraCode = true; });
  await expect(cartLineQuantity(page, 'E2E product 2')).toHaveText('1');
  await page.waitForTimeout(1_000);
  await expect(e2e2Lines(page)).toHaveCount(1);
  await expect(cartLineQuantity(page, 'E2E product 2')).toHaveText('1');
  await expect(page.getByTestId('scan-toast')).toContainText('Added to cart');
  await expect(page.getByTestId('scan-toast')).toContainText('E2E product 2');
  await page.evaluate(() => { (window as unknown as { __cameraCode: boolean }).__cameraCode = false; });

  await page.getByTestId('camera-scanner-close').click();
  await expect(panel(page)).toHaveCount(0);
  await expect(button(page)).toBeVisible();
  await expect(e2e2Lines(page)).toHaveCount(1);
});

test('a denied camera shows TU\'s message in the scanner and adds nothing', async ({ page }) => {
  await page.addInitScript(cameraStub, { code: E2E2_BARCODE, denied: true });
  await signIn(page);
  await turnCameraOn(page);
  await openArea(page, 'POS');
  await button(page).click();
  await expect(panel(page)).toBeVisible();
  await expect(page.getByTestId('camera-scanner-status'))
    .toHaveText('Camera access was denied — allow it in the browser settings and reopen the scanner.');
  await page.evaluate(() => { (window as unknown as { __cameraCode: boolean }).__cameraCode = true; });
  await page.waitForTimeout(1_000);
  await expect(page.getByTestId('cart-empty')).toBeVisible();
  await expect(e2e2Lines(page)).toHaveCount(0);
});

test('the page\'s Permissions-Policy lets this origin use the camera', async ({ page }) => {
  const response = await page.goto('/');
  expect(response?.headers()['permissions-policy']).toContain('camera=(self)');
  expect(response?.headers()['permissions-policy']).toContain('microphone=()');
});

type CameraWindow = { __cameraStream?: MediaStream; __firstStream?: MediaStream };
const trackState = (page: Page) => page.evaluate(() =>
  (window as unknown as CameraWindow).__cameraStream?.getVideoTracks()[0]?.readyState ?? 'none');

// The Sale stays mounted under the areas; the scanner is drawn only while the Sale's cart is in front, so its stream stops.
test('leaving the Sale stops the camera; back on the Sale the scanner reopens on a new live stream', async ({ page }) => {
  await page.addInitScript(cameraStub, { code: E2E2_BARCODE, denied: false });
  await signIn(page);
  await turnCameraOn(page);
  await openArea(page, 'POS');
  await button(page).click();
  await expect(panel(page)).toBeVisible();
  await expect.poll(() => trackState(page)).toBe('live');
  await page.evaluate(() => { const w = window as unknown as CameraWindow; w.__firstStream = w.__cameraStream; });

  await openArea(page, 'Settings');
  await expect.poll(() => trackState(page)).toBe('ended');

  await openArea(page, 'POS');
  await expect(panel(page)).toBeVisible();
  await expect.poll(() => trackState(page)).toBe('live');
  expect(await page.evaluate(() => { const w = window as unknown as CameraWindow; return w.__cameraStream !== w.__firstStream; }))
    .toBe(true);
});

// A count makes the catalogue inert, so the scanner goes with it; Back to selling (TU, the session stays open) brings it back.
test('a register count stops the camera and hides its button; Back to selling shows the button again', async ({ page }) => {
  await page.addInitScript(cameraStub, { code: E2E2_BARCODE, denied: false });
  await signIn(page);
  await turnCameraOn(page);
  await openArea(page, 'POS');
  await button(page).click();
  await expect.poll(() => trackState(page)).toBe('live');
  await openRegisterPanel(page);
  await page.getByTestId('register-panel').getByTestId('register-panel-close').click();
  await expect(page.getByTestId('register-count')).toBeVisible();
  await expect(panel(page)).toHaveCount(0);
  await expect(button(page)).toHaveCount(0);
  await expect.poll(() => trackState(page)).toBe('ended');
  await page.getByTestId('register-count').getByTestId('count-back').click();
  await expect(page.getByTestId('register-count')).toHaveCount(0);
  await expect(button(page)).toBeVisible();
});

test('a browser without BarcodeDetector shows no camera button and no Use camera switch, even with it saved on', async ({ page }) => {
  await page.addInitScript(() => {
    for (let o: object | null = window; o; o = Object.getPrototypeOf(o)) Reflect.deleteProperty(o, 'BarcodeDetector');
  });
  await signIn(page);
  await page.evaluate(() => {
    const { baseUrl } = JSON.parse(localStorage.getItem('medusapos.session')!) as { baseUrl: string };
    localStorage.setItem(`medusapos.scanner.${baseUrl}`, JSON.stringify({ camera: true }));
  });
  await page.reload();
  expect(await page.evaluate(() => typeof (window as unknown as { BarcodeDetector?: unknown }).BarcodeDetector)).toBe('undefined');
  await expect(page.getByRole('searchbox')).toBeVisible();
  await expect(button(page)).toHaveCount(0);

  await openArea(page, 'Settings');
  await page.getByTestId('settings-nav-scanner').click();
  await expect(page.getByTestId('settings-scanner-sound')).toBeVisible();
  await expect(page.getByTestId('settings-scanner-camera')).toHaveCount(0);
});

test('the scanner\'s dragged height is kept', async ({ page }) => {
  await page.addInitScript(cameraStub, { code: E2E2_BARCODE, denied: false });
  await signIn(page);
  await turnCameraOn(page);
  await openArea(page, 'POS');
  await button(page).click();
  const height = async () => (await panel(page).boundingBox())?.height ?? 0;
  await expect.poll(async () => Math.abs(await height() - 176)).toBeLessThanOrEqual(2);
  const handle = (await page.getByTestId('camera-scanner-resize-handle').boundingBox())!;
  const x = handle.x + handle.width / 2, y = handle.y + handle.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + 64, { steps: 8 });
  await page.mouse.up();
  expect(Math.abs(await height() - 240)).toBeLessThanOrEqual(2);
  const saved = () => page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.startsWith('medusapos.scanner.'));
    return key ? JSON.parse(localStorage.getItem(key)!) as { camera?: boolean; cameraHeight?: number } : null;
  });
  await expect.poll(async () => { const s = await saved(); return s?.camera === true && Math.abs(s.cameraHeight! - 240) <= 2; }).toBe(true);
  await page.reload();
  await button(page).click();
  await expect.poll(async () => Math.abs(await height() - 240)).toBeLessThanOrEqual(2);
});
