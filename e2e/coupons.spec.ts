import { expect, type Page, type Response } from '@playwright/test';
import { addE2E1, adminToken, captureCommands, cartTotalRow, ordersByClientId, signIn, tenderCash, test } from './helpers';
import { E2E_RUN } from './ports';

// Till coupons (ADR 0025, parity row 7): the till prices a Medusa promotion code through POST /tally/v1/promotions/preview
// and a coupon sale goes out as order.create v6; the plugin writes the coupon as an item adjustment carrying the promotion.
const backend = process.env.E2E_BACKEND_URL ?? `http://localhost:${E2E_RUN.backendPort}`;
type Sale = { clientOrderId: string; coupons?: { code: string; couponId: string; discountMinor: number; discountTaxMinor: number }[] };
type Adjustment = { amount: number; promotion_id: string | null; code: string | null };

// A manual, fixed promotion of `amount` EUR across the items, as an admin creates it; the code is stored upper case.
async function createPromotion(token: string, { code, amount }: { code: string; amount: number }): Promise<{ id: string; code: string }> {
  const response = await fetch(`${backend}/admin/promotions`, { method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, type: 'standard', status: 'active', is_automatic: false, is_tax_inclusive: false,
      application_method: { type: 'fixed', target_type: 'items', allocation: 'across', value: amount, currency_code: 'eur' } }) });
  expect(response.ok, await response.clone().text()).toBeTruthy();
  return (await response.json()).promotion;
}
const uniqueCode = (prefix: string) => `${prefix}-${Date.now()}`;

// The response applying the sale itself (as in discount.spec.ts), and that batch's results for its one sale.
const appliedResponse = (page: Page) => page.waitForResponse(async (response) => {
  const request = response.request();
  if (request.method() !== 'POST' || response.url() !== `${backend}/tally/v1/commands`) return false;
  const sales = request.postDataJSON().commands.filter((command: { type: string }) => command.type === 'order.create');
  return ((await response.json()).results ?? []).some((result: { id: string; status: string }) =>
    result.status === 'applied' && sales.some((sale: { id: string }) => sale.id === result.id));
});
async function saleResults(response: Response) {
  const sales = response.request().postDataJSON().commands.filter((command: { type: string }) => command.type === 'order.create');
  expect(sales).toHaveLength(1);
  return (await response.json()).results.filter((result: { id: string }) => result.id === sales[0].id);
}

const field = (page: Page) => page.getByTestId('coupon-field');
const couponRows = (page: Page) => page.locator('[data-testid^="coupon-row-"]');
async function applyCode(page: Page, code: string) {
  await page.getByLabel('Coupon code', { exact: true }).fill(code);
  await page.getByTestId('coupon-apply').click();
}

test('a €1.00 coupon typed in lower case prices the cart at €3.75, and Medusa writes the same order with the promotion\'s adjustment', async ({ page }) => {
  const token = await adminToken();
  const promotion = await createPromotion(token, { code: uniqueCode('E2E-SAVE'), amount: 1 });
  const commands = captureCommands<Sale>(page);
  await signIn(page);
  await addE2E1(page);
  await addE2E1(page);
  await applyCode(page, promotion.code.toLowerCase());
  const row = page.getByTestId(`coupon-row-${promotion.code.toLowerCase()}`);
  await expect(row).toContainText(`Coupon ${promotion.code}`);
  await expect(row).toContainText(/−\D*1\.00/);
  await expect(field(page).getByRole('alert')).toHaveCount(0);
  // 2 × €2.00 less the €1.00 coupon is €3.00 net, plus 25% VAT (€0.75) = €3.75.
  await expect(cartTotalRow(page, 'Total')).toHaveText(/^Total\D*3\.75$/);
  await expect(cartTotalRow(page, 'Subtotal')).toHaveText(/^Subtotal\D*4\.00$/);
  await expect(cartTotalRow(page, 'VAT 25%')).toHaveText(/^VAT 25%\D*0\.75$/);
  // The coupon reads on its own row, never again as a cart Discount.
  await expect(cartTotalRow(page, 'Discount').filter({ hasText: /1\.00/ })).toHaveCount(0);
  const applied = appliedResponse(page);
  await page.getByTestId('cart-checkout').click();
  await tenderCash(page, 'exact');
  await page.getByRole('button', { name: 'Complete sale', exact: true }).click();
  await expect(page.getByLabel(/^Total: /)).toHaveAttribute('aria-label', /^Total: \D*3\.75$/);
  await page.getByRole('button', { name: 'New sale', exact: true }).click();
  const results = await saleResults(await applied);
  expect(results).toEqual([expect.objectContaining({ status: 'applied' })]);
  expect(results[0].warnings).toBeUndefined();
  expect(commands).toHaveLength(1);
  const [{ version, payload }] = commands;
  expect(version).toBe(6);
  expect(payload.coupons).toEqual([expect.objectContaining({ couponId: promotion.id, discountMinor: 100 })]);
  expect(results[0].serverRefs.totalMinor).toBe(375);
  const [order] = (await ordersByClientId(token)).filter((entry) => entry.metadata.tally_client_id === payload.clientOrderId);
  expect(Math.round(order.total * 100)).toBe(375);
  const response = await fetch(`${backend}/admin/orders/${order.id}?fields=items.adjustments.*`, { headers: { Authorization: `Bearer ${token}` } });
  expect(response.ok, await response.clone().text()).toBeTruthy();
  const { order: { items } } = await response.json();
  const adjustments = (items as { adjustments: Adjustment[] }[]).flatMap((item) => item.adjustments).filter((adjustment) => adjustment.promotion_id);
  expect(adjustments.length).toBeGreaterThan(0);
  for (const adjustment of adjustments) expect(adjustment).toMatchObject({ promotion_id: promotion.id, code: promotion.code });
  expect(Math.round(adjustments.reduce((sum, adjustment) => sum + Number(adjustment.amount), 0) * 100)).toBe(100);
});

test('removing an applied coupon takes its row away and puts the Total back to €2.50', async ({ page }) => {
  const promotion = await createPromotion(await adminToken(), { code: uniqueCode('E2E-REMOVE'), amount: 1 });
  await signIn(page);
  await addE2E1(page);
  await expect(cartTotalRow(page, 'Total')).toHaveText(/^Total\D*2\.50$/);
  await applyCode(page, promotion.code);
  const row = page.getByTestId(`coupon-row-${promotion.code.toLowerCase()}`);
  await expect(row).toBeVisible();
  // €2.00 − €1.00 = €1.00 net, plus 25% VAT.
  await expect(cartTotalRow(page, 'Total')).toHaveText(/^Total\D*1\.25$/);
  await page.getByRole('button', { name: `Remove coupon ${promotion.code}`, exact: true }).click();
  await expect(couponRows(page)).toHaveCount(0);
  await expect(cartTotalRow(page, 'Total')).toHaveText(/^Total\D*2\.50$/);
});

test('an unknown code shows the store\'s refusal under the field, adds no row and keeps the text', async ({ page }) => {
  const code = uniqueCode('NO-SUCH-CODE');
  await signIn(page);
  await addE2E1(page);
  await applyCode(page, code);
  // The plugin's not_found sentence (packages/medusa-plugin/src/workflows/tally-coupons/price-coupons.ts).
  await expect(field(page).getByRole('alert')).toHaveText("This coupon code isn't known to the store.");
  await expect(couponRows(page)).toHaveCount(0);
  await expect(page.getByLabel('Coupon code', { exact: true })).toHaveValue(code);
  await expect(cartTotalRow(page, 'Total')).toHaveText(/^Total\D*2\.50$/);
});

test('with the preview unreachable Apply says coupons need a connection; once it is back the coupon applies', async ({ page }) => {
  const promotion = await createPromotion(await adminToken(), { code: uniqueCode('E2E-OFFLINE'), amount: 1 });
  await signIn(page);
  await addE2E1(page);
  const preview = '**/tally/v1/promotions/preview';
  await page.route(preview, (route) => route.abort());
  await applyCode(page, promotion.code);
  await expect(field(page).getByRole('alert')).toHaveText('Coupons need a connection to the store');
  await expect(couponRows(page)).toHaveCount(0);
  await page.unroute(preview);
  await page.getByTestId('coupon-apply').click();
  await expect(page.getByTestId(`coupon-row-${promotion.code.toLowerCase()}`)).toBeVisible();
  await expect(field(page).getByRole('alert')).toHaveCount(0);
  await expect(cartTotalRow(page, 'Total')).toHaveText(/^Total\D*1\.25$/);
});
