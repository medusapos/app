import { expect, type Page, type Route } from '@playwright/test';
import { adminToken, inventoryLevel, openArea, openRegisterPanel, sellBySku, setInventoryLevel, signIn, test } from './helpers';

// v2's "Open Cash Drawer" on an Epson network printer (AUDIT 13, 22 · DEMO 15c): the printer is 127.0.0.1 on the
// default port, so the till posts ePOS-Print to http://127.0.0.1:8008, answered here as a TM printer answers.
const EPSON_OK = '<response success="true" code="" status="0" battery="0"/>';
const PIN2 = '1014010003';
const PIN5 = '1014010103';
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };

test.use({ viewport: { width: 1280, height: 800 } });

/** Each ePOS-Print POST's command, as hex; the preflight is answered and not counted. */
async function printer(page: Page, answer: 'ok' | 'abort' = 'ok') {
  const sent: string[] = [];
  await page.route('**/cgi-bin/epos/service.cgi*', async (route: Route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    sent.push(/<command>([0-9a-f]*)<\/command>/.exec(request.postData() ?? '')?.[1] ?? '');
    if (answer === 'abort') return route.abort('connectionrefused');
    return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'text/xml' }, body: EPSON_OK });
  });
  return sent;
}

// Attached, and kept in the test's output folder for the docs shots.
async function shot(page: Page, state: string) {
  const file = test.info().outputPath(`${state}.png`);
  await page.screenshot({ path: file });
  await test.info().attach(`${state}.png`, { path: file, contentType: 'image/png' });
}

async function openPrinters(page: Page) {
  await openArea(page, 'Settings');
  await page.getByTestId('settings-nav-printing').click();
  await expect(page.getByTestId('settings-printers')).toBeVisible();
}

/** Settings › Printing › Add printer: an Epson at 127.0.0.1, default port, Open Cash Drawer on. */
async function addPrinter(page: Page, before?: () => Promise<void>) {
  await openPrinters(page);
  await page.getByTestId('settings-add-printer').click();
  const form = page.getByTestId('printer-form');
  await form.getByTestId('printer-form-name').fill('Counter');
  await form.getByTestId('printer-form-vendor-epson').click();
  await form.getByTestId('printer-form-address').fill('127.0.0.1');
  await expect(form.getByTestId('printer-form-port')).toHaveValue('9100');
  await form.getByRole('switch', { name: 'Open Cash Drawer' }).click();
  await expect(form.getByTestId('printer-form-drawer-pin2')).toBeVisible();
  await before?.();
  await form.getByTestId('printer-form-save').click();
  await expect(page.getByTestId('printer-dialog')).toHaveCount(0);
  const row = page.locator('[data-testid^="settings-printer-"]').filter({ hasText: 'Counter' }).first();
  await expect(row).toContainText('Epson · 127.0.0.1 · Opens cash drawer');
  return row;
}

async function noSale(page: Page) {
  await openRegisterPanel(page);
  await page.getByTestId('register-panel-no-sale').click();
  const sheet = page.getByTestId('movement-sheet');
  await sheet.getByTestId('movement-reason-drawer-check').click();
  await sheet.getByTestId('movement-confirm').click();
  await expect(sheet).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('register-panel')).toHaveCount(0);
}

/** Runs `body` and gives the suite's shared E2E-1 stock back afterwards, also when it fails (as coupons.spec does). */
async function keepingStock(body: () => Promise<void>) {
  const token = await adminToken();
  const level = await inventoryLevel(token, 'E2E-1');
  try { await body(); } finally { await setInventoryLevel(token, level.inventoryItemId, level.locationId, level.stockedQuantity); }
}

test('Add printer saves an Epson with Open Cash Drawer on, and its Test print reaches the printer once, with no drawer pulse', async ({ page }) => {
  const sent = await printer(page);
  await signIn(page);
  const row = await addPrinter(page, () => shot(page, 'printer-form'));
  await expect(page.getByTestId('settings-printers-note')).toBeVisible();
  await row.getByRole('button', { name: 'Test print Counter', exact: true }).click();
  await expect(page.getByText('Sent to Counter', { exact: true })).toBeVisible();
  expect(sent).toHaveLength(1);
  expect(sent[0]!.length).toBeGreaterThan(100);
  expect(sent[0]).not.toContain('101401');
  await shot(page, 'printers');
});

test('a cash sale opens the drawer once, an external sale never, and No sale once on the pin it is set to', async ({ page }) => {
  await keepingStock(async () => {
    const sent = await printer(page);
    await signIn(page);
    const row = await addPrinter(page);
    await openArea(page, 'POS');
    await sellBySku(page, ['E2E-1'], 'exact');
    await expect.poll(() => sent).toEqual([PIN2]);
    await sellBySku(page, ['E2E-1'], 'external');
    await noSale(page);
    await expect.poll(() => sent).toEqual([PIN2, PIN2]);

    await openPrinters(page);
    await row.getByRole('button', { name: 'Edit Counter', exact: true }).click();
    await page.getByTestId('printer-form-drawer-pin5').click();
    await page.getByTestId('printer-form-save').click();
    await expect(page.getByTestId('printer-dialog')).toHaveCount(0);
    await openArea(page, 'POS');
    await noSale(page);
    await expect.poll(() => sent).toEqual([PIN2, PIN2, PIN5]);
    // Nothing more arrives late: the external sale and the paid screens sent nothing of their own.
    await page.waitForTimeout(500);
    expect(sent).toEqual([PIN2, PIN2, PIN5]);
  });
});

test('once the printer is deleted, a cash sale sends nothing and still reaches the paid screen', async ({ page }) => {
  await keepingStock(async () => {
    const sent = await printer(page);
    await signIn(page);
    const row = await addPrinter(page);
    await row.getByRole('button', { name: 'Delete Counter', exact: true }).click();
    await page.getByTestId('printer-delete-confirm').click();
    await expect(page.getByTestId('printer-delete-dialog')).toHaveCount(0);
    await expect(page.locator('[data-testid^="settings-printer-"]').filter({ hasText: 'Counter' })).toHaveCount(0);
    await openArea(page, 'POS');
    await sellBySku(page, ['E2E-1'], 'exact');
    await page.waitForTimeout(500);
    expect(sent).toEqual([]);
  });
});

test('a printer that does not answer never holds up a cash sale', async ({ page }) => {
  await keepingStock(async () => {
    const sent = await printer(page, 'abort');
    await signIn(page);
    await addPrinter(page);
    await openArea(page, 'POS');
    // sellBySku waits for the paid screen's New sale and starts the next sale.
    await sellBySku(page, ['E2E-1'], 'exact');
    await expect.poll(() => sent).toEqual([PIN2]);
    await expect(page.getByPlaceholder('Search or scan barcode / SKU', { exact: true })).toBeVisible();
  });
});
