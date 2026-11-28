import { expect, type Page } from '@playwright/test';
import { addE2E1, adminToken, appliedResponse, inventoryLevel, setInventoryLevel, signIn, startTender, tenderCash, test } from './helpers';

// v2's paid screen: one footer bar along the bottom of the left pane (Email receipt, Print receipt, New sale) and a ✕ at
// the pane's top right that starts the next sale.

// The suite shares E2E-1 stock: read its level before each test sells, give it back after (also when the test fails).
let token: string;
let level: Awaited<ReturnType<typeof inventoryLevel>>;
test.beforeEach(async () => {
  token = await adminToken();
  level = await inventoryLevel(token, 'E2E-1');
});
test.afterEach(async () => {
  await setInventoryLevel(token, level.inventoryItemId, level.locationId, level.stockedQuantity);
});

// One E2E-1 paid with 5.00 in cash, so the paid screen leads with the change; waits until the store has applied it.
async function paidWithChange(page: Page) {
  await signIn(page);
  await addE2E1(page);
  await startTender(page, 'cash');
  await tenderCash(page, 5);
  const applied = appliedResponse(page);
  await page.getByTestId('tender-complete').click();
  await expect(page.getByTestId('paid-change-due')).toBeVisible();
  await applied;
}

const box = async (page: Page, testId: string) => (await page.getByTestId(testId).boundingBox())!;
const centreY = (b: { y: number; height: number }) => b.y + b.height / 2;

test('the paid footer is one bar along the bottom of the left pane, and the ✕ starts a new sale', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await paidWithChange(page);
  const footer = page.getByTestId('paid-footer');
  await expect(footer.getByRole('button', { name: 'Print receipt', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Print receipt', exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'New sale', exact: true })).toHaveCount(1);

  // Tablet: the bar sits on the viewport's bottom, left of the summary column, its three buttons in one row.
  const bar = await box(page, 'paid-footer');
  expect(Math.abs(bar.y + bar.height - 768)).toBeLessThanOrEqual(2);
  const summary = await box(page, 'paid-summary');
  expect(bar.x + bar.width).toBeLessThanOrEqual(summary.x);
  const [email, print, next] = await Promise.all(['receipt-email-open', 'paid-print', 'paid-new-sale'].map((id) => box(page, id)));
  expect(Math.abs(centreY(email) - centreY(print))).toBeLessThanOrEqual(4);
  expect(Math.abs(centreY(print) - centreY(next))).toBeLessThanOrEqual(4);
  expect(email.x + email.width).toBeLessThanOrEqual(print.x);
  expect(print.x + print.width).toBeLessThanOrEqual(next.x);
  // The ✕ at the left pane's top right, a 44 px target.
  const close = await box(page, 'paid-close');
  const pane = await box(page, 'paid-pane');
  expect(close.y).toBeLessThanOrEqual(96);
  expect(close.y + close.height).toBeLessThanOrEqual(96);
  expect(pane.x + pane.width - (close.x + close.width)).toBeLessThanOrEqual(24);
  expect(close.x + close.width).toBeLessThanOrEqual(summary.x);
  expect(Math.min(close.width, close.height)).toBeGreaterThanOrEqual(44);

  // Phone: the bar may wrap, but it is in view without scrolling and nothing overflows sideways.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId('paid-summary')).toHaveCount(0);
  const phoneBar = await box(page, 'paid-footer');
  expect(phoneBar.y).toBeGreaterThanOrEqual(0);
  expect(phoneBar.x).toBeGreaterThanOrEqual(0);
  expect(phoneBar.y + phoneBar.height).toBeLessThanOrEqual(844);
  expect(phoneBar.x + phoneBar.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.getByTestId('paid-close')).toBeInViewport();

  await page.getByTestId('paid-close').click();
  await expect(page.getByTestId('paid-footer')).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(page.getByTestId('cart-empty')).toBeVisible();
});

test('the thermal template keeps one Print receipt and one New sale in the footer bar', async ({ page }) => {
  await paidWithChange(page);
  await page.getByTestId('receipt-template-select').click();
  await page.getByTestId('receipt-template-option-thermal-80mm').click();
  await expect(page.getByTestId('receipt-thermal-frame')).toBeVisible();
  const footer = page.getByTestId('paid-footer');
  await expect(page.getByRole('button', { name: 'Print receipt', exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'New sale', exact: true })).toHaveCount(1);
  await expect(footer.getByRole('button', { name: 'Print receipt', exact: true })).toBeVisible();
  await expect(footer.getByRole('button', { name: 'New sale', exact: true })).toBeVisible();
  await footer.getByRole('button', { name: 'New sale', exact: true }).click();
  await expect(page.getByTestId('cart-empty')).toBeVisible();
});

test('the paid receipt prints whole on a short window', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 420 });
  await paidWithChange(page);
  await page.emulateMedia({ media: 'print' });
  // On screen the receipt scrolls above the bar; a print unclips it, so the tender and change rows reach the page.
  const scroll = page.getByTestId('paid-scroll');
  const metrics = await scroll.evaluate((el) => ({
    overflowY: getComputedStyle(el).overflowY, height: el.getBoundingClientRect().height, scrollHeight: el.scrollHeight,
  }));
  expect(metrics.overflowY).toBe('visible');
  expect(metrics.height).toBeGreaterThanOrEqual(metrics.scrollHeight - 1);
  await expect(page.getByTestId('paid-pane').getByText('Change', { exact: true })).toBeVisible();
});

test('a receipt sent to a long address stays inside the phone', async ({ page }) => {
  // The store's send, stubbed: a 200 that the app's cross-origin fetch accepts.
  await page.route('**/receipt-email', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}',
    headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' } }));
  // The sale at the desktop size (the cart's Checkout), then the paid screen on a phone.
  await paidWithChange(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const address = 'accounts.payable.department@very-long-company-name.example.com';
  await page.getByTestId('receipt-email-open').click();
  await page.getByTestId('receipt-email-field').fill(address);
  await page.getByTestId('receipt-email-send').click();
  // The sent line wraps inside the bar, and the Email receipt button keeps its own width.
  const footer = page.getByTestId('paid-footer');
  const sent = footer.getByText(`Receipt sent to ${address}.`);
  await expect(sent).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const email = await box(page, 'receipt-email-open');
  expect(email.x + email.width).toBeLessThanOrEqual(390);
  const print = await box(page, 'paid-print');
  const next = await box(page, 'paid-new-sale');
  expect(Math.max(email.y, print.y, next.y) - Math.min(email.y, print.y, next.y)).toBeLessThanOrEqual(1);
  expect((await sent.boundingBox())!.y).toBeGreaterThanOrEqual(print.y + print.height);

  await page.getByTestId('receipt-template-select').click();
  await page.getByTestId('receipt-template-option-thermal-80mm').click();
  await expect(sent).toBeVisible();
  await page.getByTestId('paid-new-sale').click();
  await page.setViewportSize({ width: 1024, height: 768 });
  await addE2E1(page);
  await startTender(page, 'cash');
  await tenderCash(page, 5);
  const applied = appliedResponse(page);
  await page.getByTestId('tender-complete').click();
  await expect(page.getByTestId('paid-change-due')).toBeVisible();
  await expect(footer.getByText(/Receipt sent to/)).toHaveCount(0);
  await applied;
});

// #658: the paid screen's thermal frame at a viewport size, once its page has loaded and the frame has fitted it.
async function thermalFrame(page: Page, templateId: string, size: { width: number; height: number }, sell = paidWithChange) {
  await sell(page);
  await page.setViewportSize(size);
  await page.getByTestId('receipt-template-select').click();
  await page.getByTestId(`receipt-template-option-${templateId}`).click();
  const frame = page.getByTestId('receipt-thermal-frame');
  await expect(frame).toBeVisible();
  const inside = (await (await frame.elementHandle())!.contentFrame())!;
  await inside.waitForLoadState('load');
  await expect(inside.locator('body > div').first()).toBeVisible();
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  // The frame's drawn box, its applied scale (drawn width over layout width) and the bordered box that clips it;
  // height is the drawn height the clip shows, 520 whatever the scale.
  const outer = await frame.evaluate((el) => {
    const drawn = el.getBoundingClientRect();
    const clip = el.parentElement!;
    return { left: drawn.left, right: drawn.right, scale: drawn.width / el.offsetWidth,
      visible: Math.min(drawn.width, clip.clientWidth), height: Math.min(drawn.height, clip.clientHeight) };
  });
  // Also the page's height, the frame's own vertical scrollbar now (0 when it does not scroll, or the scrollbar
  // overlays), and the width a classic scrollbar takes in this frame, read off a scrolling probe added and removed.
  const doc = await inside.evaluate(() => {
    const probe = document.body.appendChild(document.createElement('div'));
    probe.style.cssText = 'position: absolute; width: 100px; height: 50px; overflow-y: scroll';
    const classicBar = probe.offsetWidth - probe.clientWidth;
    probe.remove();
    return {
      pageRight: Math.max(...Array.from(document.body.children, (el) => el.getBoundingClientRect().right)),
      scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth,
      pageHeight: document.documentElement.getBoundingClientRect().height, bar: innerWidth - document.documentElement.clientWidth, classicBar,
    };
  });
  return { ...outer, ...doc };
}

test('the 80mm thermal page fits a phone frame whole, scaled down', async ({ page }) => {
  const fit = await thermalFrame(page, 'thermal-80mm', { width: 390, height: 844 });
  expect(Math.abs(fit.height - 520)).toBeLessThanOrEqual(1);
  expect(fit.pageRight * fit.scale).toBeLessThanOrEqual(fit.visible + 0.5);
  expect(fit.scrollWidth).toBeLessThanOrEqual(fit.clientWidth);
  expect(fit.left).toBeGreaterThanOrEqual(0);
  expect(fit.right).toBeLessThanOrEqual(390);
  expect(fit.scale).toBeLessThan(1);
});

test('the 80mm thermal page shows unscaled on a desktop', async ({ page }) => {
  const fit = await thermalFrame(page, 'thermal-80mm', { width: 1280, height: 720 });
  expect(Math.abs(fit.height - 520)).toBeLessThanOrEqual(1);
  expect(fit.scale).toBeCloseTo(1, 3);
  expect(fit.pageRight).toBeLessThanOrEqual(fit.visible + 0.5);
});

test('the 58mm thermal page fits a phone frame unscaled', async ({ page }) => {
  const fit = await thermalFrame(page, 'thermal-58mm', { width: 390, height: 844 });
  expect(Math.abs(fit.height - 520)).toBeLessThanOrEqual(1);
  expect(fit.scale).toBeCloseTo(1, 3);
  expect(fit.pageRight).toBeLessThanOrEqual(fit.visible + 0.5);
  expect(fit.scrollWidth).toBeLessThanOrEqual(fit.clientWidth);
});

// #667 items 2-3: with a classic scrollbar (Windows, desktop Linux) the frame counts the scrollbar's width only while
// the frame, at its final size, still scrolls. Headless Chromium hides scrollbars, so a test without one proves nothing.
// A launch option cannot be set for one describe group, so these tests take their context from a browser launched
// without --hide-scrollbars (headless Chromium's default), which draws classic 15px scrollbars on macOS and Linux alike.
const classic = test.extend({
  context: async ({ playwright, launchOptions, baseURL, viewport, userAgent, deviceScaleFactor }, use) => {
    const browser = await playwright.chromium.launch({ ...launchOptions, ignoreDefaultArgs: ['--hide-scrollbars'] });
    await use(await browser.newContext({ baseURL, viewport, userAgent, deviceScaleFactor }));
    await browser.close();
  },
});
classic.describe('with a classic scrollbar', () => {
  // This sale sells E2E-2 to E2E-5 too (and E2E-4B for six lines): give them back as well.
  const more = ['E2E-2', 'E2E-3', 'E2E-4', 'E2E-5'];
  let levels: typeof level[] | undefined;
  classic.beforeEach(async () => {
    levels = undefined;
    levels = await Promise.all([...more, 'E2E-4B'].map((sku) => inventoryLevel(token, sku)));
  });
  // A level that failed to read leaves nothing to give back; the read's own error is the one to see. A level read below
  // 0 (earlier specs sell these with backorders and never give them back) is left alone: the API refuses a negative
  // stocked_quantity, and clamping to 0 would add stock nobody gave back.
  classic.afterEach(async () => {
    for (const l of levels ?? []) {
      if (l.stockedQuantity >= 0) await setInventoryLevel(token, l.inventoryItemId, l.locationId, l.stockedQuantity);
    }
  });

  // Five lines, paid exactly: an 80mm page about 548px tall. That is taller than the unscaled 520px frame, so the frame
  // scrolls when its page loads, but no taller than the frame once scaled to the page's own 399px at 390 wide
  // (520 x 399 / 356, about 583px): at its final size the frame does not scroll.
  async function paidFiveLines(page: Page, extra: string[] = []) {
    await signIn(page);
    const search = page.getByPlaceholder('Search or scan barcode / SKU', { exact: true });
    for (const sku of ['E2E-1', ...more, ...extra]) {
      await search.fill(sku);
      await search.press('Enter');
      await expect(search).toHaveValue('');
    }
    await startTender(page, 'cash');
    await tenderCash(page, 'exact');
    const applied = appliedResponse(page);
    await page.getByTestId('tender-complete').click();
    await expect(page.getByRole('button', { name: 'New sale', exact: true })).toBeVisible();
    await applied;
  }

  classic('scrollbar: an 80mm page the scaled frame no longer scrolls fills the frame, with no strip for a stale scrollbar', async ({ page }) => {
    const fit = await thermalFrame(page, 'thermal-80mm', { width: 390, height: 844 }, paidFiveLines);
    expect(fit.classicBar).toBeGreaterThan(0);
    expect(fit.pageHeight).toBeGreaterThan(520);
    expect(fit.bar).toBe(0);
    expect(fit.scale).toBeLessThan(1);
    expect(fit.pageRight * fit.scale).toBeLessThanOrEqual(fit.visible + 0.5);
    expect(fit.visible - fit.pageRight * fit.scale).toBeLessThanOrEqual(1);
    expect(fit.scrollWidth).toBeLessThanOrEqual(fit.clientWidth);
  });

  // #677: six lines, an 80mm page about 584px tall. That is in the band between the frame's height at the page's own
  // 399px (520 x 399 / 356, about 583px) and at 399px plus the 15px scrollbar (520 x 414 / 356, about 605px): the
  // frame is widened just enough to stop scrolling, and Chromium's whole-pixel viewport must not leave it scrolling.
  classic('scrollbar: an 80mm page in the band between the two widths widens the frame until it no longer scrolls', async ({ page }) => {
    const fit = await thermalFrame(page, 'thermal-80mm', { width: 390, height: 844 }, (p) => paidFiveLines(p, ['E2E-4B']));
    expect(fit.classicBar).toBeGreaterThan(0);
    expect(fit.pageHeight).toBeGreaterThan(520 * Math.ceil(fit.pageRight) / 356);
    expect(fit.pageHeight).toBeLessThan(520 * (Math.ceil(fit.pageRight) + fit.classicBar) / 356);
    expect(fit.bar).toBe(0);
    expect(fit.scrollWidth).toBeLessThanOrEqual(fit.clientWidth);
    expect(fit.pageRight * fit.scale).toBeLessThanOrEqual(fit.visible + 0.5);
  });
});
