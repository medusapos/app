import { buildReceiptNotification, isTillOrder, parseReceiptEmailBody, type ReceiptOrder } from '../receipt-email'

const order: ReceiptOrder = {
  id: 'order_1', display_id: 7, currency_code: 'eur', created_at: '2026-01-02T00:00:00.000Z', is_draft_order: false,
  metadata: {
    tally_client_id: 'client-1', tally_created_at: '2026-01-01T09:00:00.000Z',
    tally_pos_totals: { v: 1, currency: 'EUR', exponent: 2,
      settlement: { subtotalMinor: 840, discountMinor: 0, taxMinor: 160, totalMinor: 1000 } },
  },
  raw_total: { value: '10' }, raw_subtotal: { value: '8.40336134453781512605' },
  raw_tax_total: { value: '1.59663865546218487395' }, raw_discount_total: { value: '0' }, raw_shipping_total: { value: 0 },
  items: [
    { id: 'ordli_1', title: 'Coffee', variant_title: 'Large', variant_sku: 'A',
      raw_quantity: { value: '2' }, raw_unit_price: { value: '4.5' }, raw_total: { value: '9' } },
    { id: 'ordli_2', title: 'Service fee', variant_title: null, variant_sku: null,
      raw_quantity: { value: 1 }, raw_unit_price: { value: 1 }, raw_total: { value: 1 } },
  ],
}

it('parses an email and defaults saveToBilling to false', () => {
  expect(parseReceiptEmailBody({ email: 'Buyer@Example.com' })).toEqual({
    ok: true, value: { email: 'Buyer@Example.com', saveToBilling: false },
  })
  expect(parseReceiptEmailBody({ email: 'buyer@example.com', saveToBilling: true })).toEqual({
    ok: true, value: { email: 'buyer@example.com', saveToBilling: true },
  })
})

it.each([
  null, [], {}, { email: 42 }, { email: 'invalid' }, { email: ' buyer@example.com' },
  { email: 'a'.repeat(243) + '@example.com' },
])('refuses %j', body => {
  expect(parseReceiptEmailBody(body)).toEqual({ ok: false, message: 'email: expected an email address of at most 254 characters' })
})

it('refuses a non-boolean saveToBilling after the email error', () => {
  expect(parseReceiptEmailBody({ email: 'invalid', saveToBilling: 'yes' })).toEqual({
    ok: false, message: 'email: expected an email address of at most 254 characters; saveToBilling: expected a boolean',
  })
  expect(parseReceiptEmailBody({ email: 'buyer@example.com', saveToBilling: 'yes' })).toEqual({
    ok: false, message: 'saveToBilling: expected a boolean',
  })
})

it.each([
  [{ metadata: { tally_client_id: 'c' } }, true],
  [{ metadata: { tally_client_id: 'c' }, is_draft_order: true }, false],
  [{ metadata: null }, false],
  [{}, false],
  [{ metadata: { tally_client_id: 7 } }, false],
] as const)('isTillOrder %j', (value, expected) => {
  expect(isTillOrder(value)).toBe(expected)
})

it("builds the email notification from the order and the till's figures", () => {
  const notification = buildReceiptNotification(order, 'buyer@example.com')
  expect(notification).toEqual({
    to: 'buyer@example.com', channel: 'email', template: 'tally-pos-receipt', trigger_type: 'tally.receipt_email',
    resource_id: 'order_1', resource_type: 'order',
    data: {
      order: {
        id: 'order_1', displayId: '7', clientOrderId: 'client-1', createdAt: '2026-01-01T09:00:00.000Z',
        currencyCode: 'eur', exponent: 2,
        items: [
          { title: 'Coffee', variantTitle: 'Large', sku: 'A', quantity: 2, unitPriceMinor: 450, totalMinor: 900 },
          { title: 'Service fee', variantTitle: null, sku: null, quantity: 1, unitPriceMinor: 100, totalMinor: 100 },
        ],
        subtotalMinor: 840, taxTotalMinor: 160, discountTotalMinor: 0, shippingTotalMinor: 0, totalMinor: 1000,
      },
      posTotals: order.metadata!.tally_pos_totals,
    },
  })
  expect(notification.data.posTotals).not.toBe(order.metadata!.tally_pos_totals)
})

it("falls back to the order's own time and null figures", () => {
  const notification = buildReceiptNotification({ ...order, metadata: { tally_client_id: 'client-1' } }, 'buyer@example.com')
  expect(notification.data.order.createdAt).toBe('2026-01-02T00:00:00.000Z')
  expect(notification.data.posTotals).toBeNull()
})

it("uses the currency's own exponent", () => {
  const notification = buildReceiptNotification({ ...order, currency_code: 'jpy', raw_total: { value: '1000' } }, 'buyer@example.com')
  expect(notification.data.order.exponent).toBe(0)
  expect(notification.data.order.totalMinor).toBe(1000)
})
