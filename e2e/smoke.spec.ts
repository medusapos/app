import { expect, test } from '@playwright/test';
import { adminToken, ordersByClientId, sellBySku, signIn, stockBySku } from './helpers';

test('cash sale is completed, captured and deducted from stock', async ({ page }) => {
  const token = await adminToken();
  const before = await stockBySku(token);
  expect(before['E2E-1']).toBe(50);
  expect(before['E2E-4']).toBe(50);
  await signIn(page);
  const receiptTotal = await sellBySku(page, ['E2E-1', 'E2E-4'], 'exact');
  expect(receiptTotal).toBe(15);
  await expect(page.getByText('All sales synced', { exact: true })).toBeVisible();
  const orders = await ordersByClientId(token);
  expect(orders).toHaveLength(1);
  const [order] = orders;
  expect(order.status).toBe('completed');
  expect(order.payment_status).toBe('captured');
  expect(order.total).toBe(receiptTotal);
  expect(order.payment_collections).toHaveLength(1);
  expect(order.payment_collections[0].amount).toBe(receiptTotal);
  expect(order.items).toHaveLength(2);
  expect(order.items.every(item => item.quantity === 1 && item.variant_id)).toBe(true);
  const after = await stockBySku(token);
  expect(after['E2E-1']).toBe(before['E2E-1'] - 1);
  expect(after['E2E-4']).toBe(before['E2E-4'] - 1);
});
