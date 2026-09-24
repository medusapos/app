import { expect, test } from '@playwright/test';
import { adminToken, captureSales, ordersByClientId, sellBySku, signIn, stockBySku } from './helpers';

// Compare exact EUR minor units at the API decimal's scale, preserving sub-cent precision.
function expectEurAmount(major: number, minor: number, toleranceMinor: number) {
  expect(String(major)).toMatch(/^\d+(\.\d+)?$/);
  const [whole, fraction = ''] = String(major).split('.');
  const scale = 10n ** BigInt(fraction.length);
  const difference = BigInt(whole + fraction) * 100n - BigInt(minor) * scale;
  expect(difference < 0n ? -difference : difference).toBeLessThanOrEqual(BigInt(toleranceMinor) * scale);
}

test('25 sales, 20 offline, land exactly once', async ({ page, context }) => {
  test.setTimeout(15 * 60_000);
  const token = await adminToken();
  const before = await stockBySku(token);
  expect(before['E2E-5']).toBe(2);
  const sales = captureSales(page);
  const receiptTotals: number[] = [];
  await signIn(page);
  const sync = page.getByLabel('Sync status', { exact: true });
  // Repeated scans add quantity; these baskets have 1–3 lines and 1–3 of each SKU.
  const baskets = [
    ['E2E-1'],
    ['E2E-2', 'E2E-2', 'E2E-3'],
    ['E2E-3', 'E2E-3', 'E2E-3', 'E2E-4'],
    ['E2E-1', 'E2E-1', 'E2E-2', 'E2E-4', 'E2E-4'],
    ['E2E-2', 'E2E-3', 'E2E-4', 'E2E-4', 'E2E-4'],
  ];
  const sold: Record<string, number> = { 'E2E-1': 0, 'E2E-2': 0, 'E2E-3': 0, 'E2E-4': 0, 'E2E-5': 0 };
  for (let i = 0; i < 5; i++) {
    const basket = baskets[i];
    receiptTotals.push(await sellBySku(page, basket, i % 2 === 0 ? 'exact' : 100));
    for (const sku of basket) sold[sku]++;
    await expect(sync).toHaveText('All sales synced');
    expect(sales.size).toBe(i + 1);
    expectEurAmount(receiptTotals[i], [...sales.values()][i].totalMinor, 0);
  }
  expect(sales.size).toBe(5);

  await context.setOffline(true);
  for (let i = 0; i < 20; i++) {
    const basket = i === 19 ? ['E2E-5', 'E2E-5', 'E2E-5'] : baskets[i % baskets.length];
    receiptTotals.push(await sellBySku(page, basket, i === 19 ? 'external' : i % 2 === 0 ? 'exact' : 100));
    for (const sku of basket) sold[sku]++;
    // Sending/retry detail may follow the exact waiting count.
    const label = `${i + 1} sale${i === 0 ? '' : 's'} waiting to sync`;
    await expect(sync).toHaveText(new RegExp(`^${label}(?: · .+)?$`));
  }
  await context.setOffline(false);
  await expect(sync).toHaveText('All sales synced', { timeout: 3 * 60_000 });

  expect(sales.size).toBe(25);
  expect(receiptTotals).toHaveLength(25);
  const clientIds = [...sales.keys()];
  expect(new Set(clientIds).size).toBe(25);
  const orders = (await ordersByClientId(token)).filter(order => sales.has(order.metadata.tally_client_id!));
  expect(orders).toHaveLength(25);
  // Capture insertion order matches sale order, including queued offline sales and retries.
  for (const [index, clientId] of clientIds.entries()) {
    await test.step(`Order ${clientId}`, async () => {
      const matches = orders.filter(order => order.metadata.tally_client_id === clientId);
      expect(matches).toHaveLength(1);
      const [order] = matches;
      const sale = sales.get(clientId)!;
      expectEurAmount(receiptTotals[index], sale.totalMinor, 0);
      expect(order.status).toBe('completed');
      expect(order.payment_status).toBe('captured');
      expectEurAmount(order.total, sale.totalMinor, 1);
      expect(order.payment_collections).toHaveLength(1);
      expect(order.payment_collections[0].status).toBe('completed');
      expectEurAmount(order.payment_collections[0].amount, sale.totalMinor, 0);
      expect(order.items.map(item => [item.variant_id, item.quantity]).sort()).toEqual(
        sale.lines.map(line => [line.variantId, line.quantity]).sort());
    });
  }
  const after = await stockBySku(token);
  for (const [sku, quantity] of Object.entries(sold)) {
    expect(after[sku], `Stock delta for ${sku}`).toBe(before[sku] - quantity);
  }
  expect(after['E2E-5']).toBe(-1);

  // The only terminal sale is the deliberately short E2E-5 basket.
  const terminalSales = [...sales.values()].filter(sale => sale.payments.some(payment => payment.method === 'external'));
  expect(terminalSales).toHaveLength(1);
  const [shortSale] = terminalSales;
  expect(shortSale.lines).toHaveLength(1);
  expect(shortSale.lines[0].quantity).toBe(3);
  const shortOrders = orders.filter(order => order.metadata.tally_client_id === shortSale.clientOrderId);
  expect(shortOrders).toHaveLength(1);
  const [shortOrder] = shortOrders;
  expect(shortOrder.status).toBe('completed');
  await page.getByRole('button', { name: /^Orders(?: \(\d+\))?$/ }).click();
  const attention = page.getByRole('heading', { name: 'Needs attention', exact: true }).locator('..');
  const row = attention.getByText(`Order #${shortOrder.display_id} ·`, { exact: false }).locator('..');
  await expect(row).toBeVisible();
  await expect(row.getByText('Stock short by 1 for E2E product 5', { exact: true })).toBeVisible();
});
