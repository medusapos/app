import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerCapabilities, StoreOrderRefundLine } from '@tallyui/core';
import { refundableLines } from '@tallyui/pos';
import { authHeaders, createPosConnector } from '../lib/pos-connector';
import { refundFormInput } from '../lib/refund';

// #644: a till refund with no lines (adjustment or shipping only) comes back from the plugin's GET /tally/v1/orders
// with `lines: []`. Read through the real @tallyui/connector-medusa as the Orders sheet reads it (store-orders.ts
// useStoreOrderWithRefundLines), it must keep the order refundable; a refund the plugin gives no `lines` stays unknown.
const BASE_URL = 'https://store.test';
const CAPABILITIES = { orderRefund: 1, pluginContract: 7 } as ServerCapabilities;

// Medusa's admin order: 2 × 6.00 sold for cash, then a 1.00 adjustment-only refund and a 1-unit refund.
const adminOrder = {
  id: 'order_1', display_id: 1001, status: 'completed', created_at: '2026-11-27T09:00:00.000Z', currency_code: 'eur',
  metadata: { tally_client_id: 'sale_1' }, total: 12, subtotal: 12, tax_total: 0, discount_total: 0, discount_tax_total: 0,
  items: [{ id: 'line_1', title: 'Blue shirt', quantity: 2, metadata: { tally_line_uuid: 'client_line_1' },
    original_total: 12, original_tax_total: 0, total: 12, tax_total: 0, tax_lines: [] }],
  shipping_methods: [],
  payment_collections: [{ payments: [{ id: 'pay_1', provider_id: 'pp_system_default', amount: 12,
    refunds: [{ id: 'refund_adjust', amount: 1, note: 'Goodwill' }, { id: 'refund_unit', amount: 6 }] }] }],
};
const unitLines: StoreOrderRefundLine[] = [{ orderLineId: 'line_1', quantity: 1, netMinor: 600, taxMinor: 0 }];
// The plugin's GET /tally/v1/orders?ids= row for that order (packages/medusa-plugin/src/api/tally/v1/orders/list.ts).
const pluginOrder = (adjustLines: StoreOrderRefundLine[] | undefined) => ({
  id: 'order_1',
  lines: [{ id: 'line_1', soldTotalMinor: 1200, soldTaxMinor: 0, returnedQuantity: 0 }],
  refunds: [
    { id: 'refund_adjust', amountMinor: 100, ...(adjustLines ? { lines: adjustLines } : {}) },
    { id: 'refund_unit', amountMinor: 600, lines: unitLines },
  ],
});

const answer = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
function stubStore(adjustLines: StoreOrderRefundLine[] | undefined) {
  const fetch = vi.fn(async (url: string) => {
    if (url.startsWith(`${BASE_URL}/admin/orders/order_1?`)) return answer({ order: adminOrder });
    if (url.startsWith(`${BASE_URL}/tally/v1/orders?`) && new URL(url).searchParams.get('ids') === 'order_1') {
      return answer({ orders: [pluginOrder(adjustLines)], hasMore: false });
    }
    throw new Error(`unexpected request ${url}`);
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
async function readOrder() {
  const connector = createPosConnector();
  const [order] = await connector.getOrders!({ connectorId: connector.id, baseUrl: BASE_URL, headers: authHeaders('t'),
    capabilities: CAPABILITIES }, ['order_1']);
  return order!;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('a till refund with no lines (#644)', () => {
  it('N1: a refund the plugin gives `lines: []` keeps the order refundable, with the remaining unit offered', async () => {
    const fetch = stubStore([]);
    const order = await readOrder();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(order.refunds).toEqual([
      { id: 'refund_adjust', amountMinor: 100, reason: 'Goodwill', lines: [] },
      { id: 'refund_unit', amountMinor: 600, lines: unitLines },
    ]);

    const input = refundFormInput(order, []);
    if (!input.offered) throw new Error(`refund form refused: ${input.reason}`);
    expect(input.refundedMinor).toBe(700);
    expect(input.orderTotalMinor).toBe(1200);
    expect([...input.tillRefunded]).toEqual([['line_1', 1]]);
    expect(refundableLines(input.lines, input.refunds)).toEqual([expect.objectContaining({ orderLineId: 'line_1', refundableQuantity: 1 })]);
    expect(input.remainderShareMinor).toBe(0);
  });

  it('N2: a refund the plugin gives no `lines` at all still refuses the form as lines_unknown', async () => {
    stubStore(undefined);
    const order = await readOrder();
    expect(order.refunds[0]).not.toHaveProperty('lines');
    expect(refundFormInput(order, [])).toEqual({ offered: false, reason: 'lines_unknown' });
  });
});
