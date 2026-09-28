import fixture from '../__fixtures__/order-create-v3.json'
import { validateBatch } from '../../../api/tally/v1/commands/process'
import { fiscalFiguresErrors, type OrderCreatePayloadV3 } from '../fiscal-figures'
import { payloadShapeErrors } from '../payload-shape'
import { planOrderCreate } from '../plan'

// JSON imports widen string literals. Narrow only the payment method, leaving the
// entire payload shape checked by this assignment to the local bridge type.
const payload: OrderCreatePayloadV3 = {
  ...fixture.payload,
  payments: fixture.payload.payments.map(payment => {
    if (payment.method !== 'cash') throw new Error('Expected the golden cash payment')
    return { ...payment, method: payment.method }
  }),
}

// All amounts are integer EUR cents; exponent = 2.
// Inclusive line: 2 * 1200 = 2400 gross; 120 line + 120 order discount = 240.
// The order discount is allocated entirely to this line, included in discountMinor.
// After discounts: 2400 - 240 = 2160 gross; 2160 / 1.20 = 1800 net; tax = 360.
// Exclusive line: 1 * 1000 = 1000 net; 1000 * 10% = 100 tax; gross = 1100.
// Settlement: subtotal = 1800 + 1000 = 2800; tax = 360 + 100 = 460;
// total = 2800 + 460 = 3260; payload discount = sum of line discounts = 240.
// Display: subtotal = 2400 + 1100 = 3500; discounts = 120 + 120 = 240;
// total = 3500 - 240 = 3260 = 2160 + 1100; orderDiscountMinor = 120.
// Cash: amount = total = 3260; tendered 4000 - amount 3260 = change 740.

it('the golden v3 envelope passes validation unchanged', () => {
  // processBatch's version rules are not exposed as a pure function; use the
  // permitted validateBatch + shape validators fallback without a container.
  expect(validateBatch({ commands: [fixture] })).toStrictEqual({ ok: true, commands: [fixture] })
  expect(payload).toStrictEqual(fixture.payload)
  expect(payloadShapeErrors(payload)).toStrictEqual([])
  expect(fiscalFiguresErrors(payload)).toStrictEqual([])
})

it('the golden v3 envelope is stored as sent', () => {
  const result = planOrderCreate(payload, {
    commandId: fixture.id,
    region: { id: 'region_golden', currency_code: 'eur', country_codes: ['es'] },
    salesChannelId: 'channel_golden',
    location: { id: 'location_golden', address: { country_code: 'es' } },
    variants: Object.fromEntries(payload.lines.map(line => [line.variantId, { id: line.variantId }])),
    customer: { id: fixture.payload.customer.customerId },
  })
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error('Expected the golden v3 plan')
  const { metadata, customer_id } = result.plan.draftOrder
  const totals = metadata.tally_pos_totals as { v: number } & Pick<OrderCreatePayloadV3, 'display' | 'taxByRate'>
  expect(totals.v).toBe(2)
  expect(totals.display).toStrictEqual(fixture.payload.display)
  expect(totals.taxByRate).toStrictEqual(fixture.payload.taxByRate)
  expect(metadata.tally_session_id).toBe(fixture.payload.sessionId)
  expect(metadata.tally_customer_id).toBe(fixture.payload.customer.customerId)
  expect(customer_id).toBe(fixture.payload.customer.customerId)
})
