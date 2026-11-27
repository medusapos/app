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
