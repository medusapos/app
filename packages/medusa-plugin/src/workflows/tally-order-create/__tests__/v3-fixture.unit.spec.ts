import fixture from '../__fixtures__/order-create-v3.json'
import { validateBatch } from '../../../api/tally/v1/commands/process'
import { SUPPORTED_ORDER_CREATE_VERSIONS } from '../../../api/tally/v1/versions'
import { fiscalFiguresErrors, type OrderCreatePayloadV3 } from '../fiscal-figures'
import { payloadShapeErrors } from '../payload-shape'
import { planOrderCreate } from '../plan'

// JSON imports widen string literals. Narrow only the payment method, leaving the
// entire payload shape checked by this assignment to the local bridge type.
// This catches missing or mistyped fields at tsc, but not extra keys: excess-property
// checks do not apply to JSON imports, and Jest (swc) does not type-check.
// Extra keys are caught at runtime: inside display and taxByRate by fiscalFiguresErrors,
// everywhere else by payloadShapeErrors (ruling 17).
const payload: OrderCreatePayloadV3 = {
  ...fixture.payload,
  payments: fixture.payload.payments.map(payment => {
    if (payment.method !== 'cash') throw new Error('Expected the golden cash payment')
    return { ...payment, method: payment.method }
  }),
}

// All amounts are integer EUR cents; exponent = 2.
// The 120 order discount is allocated as 83 inclusive + 37 exclusive net (ADR-062).
// Inclusive line: 2 * 1200 = 2400 gross; discountMinor = 203 (120 line + 83 order).
// After discounts: 2400 - 203 = 2197 gross = 1831 net + 366 tax (200000 ppm).
// Exclusive line (taxInclusive: false): 1 * 1000 - 37 discount = 963 net;
// 1059 gross = 963 net + 96 tax (100000 ppm).
// Settlement: subtotal = 1831 + 963 = 2794; tax = 366 + 96 = 462;
// total = 2794 + 462 = 3256 = 2197 + 1059; payload discount = 203 + 37 = 240.
// Display lines are before discounts (ADR-063): subtotal = 2400 + 1100 = 3500;
// display discount = 244 = 120 line + 124 order; total = 3500 - 244 = 3256.
// Display order discount = 83 + round(37 * 1.10) = 83 + 41 = 124 (exclusive share shown gross).
// Cash: amount = total = 3256; change = 744 = 4000 tendered - 3256 amount.

it('the golden v3 envelope passes validation unchanged', () => {
  // processBatch's version rules are not exposed as a pure function; use the
  // permitted validateBatch + shape validators fallback without a container.
  expect(validateBatch({ commands: [fixture] })).toStrictEqual({ ok: true, commands: [fixture] })
  expect(SUPPORTED_ORDER_CREATE_VERSIONS).toContain(fixture.version)
  expect(payload).toStrictEqual(fixture.payload)
  expect(payloadShapeErrors(payload, 3)).toStrictEqual([])
  expect(fiscalFiguresErrors(payload)).toStrictEqual([])
})

it('a 1-unit change to a taxByRate figure fails validation', () => {
  const input = structuredClone(payload)
  input.taxByRate![0].taxMinor += 1
  expect(fiscalFiguresErrors(input)).toEqual([
    'payload.taxByRate: expected the sum of taxMinor to equal payload.taxMinor',
    'payload.taxByRate[0].grossMinor: expected netMinor + taxMinor',
  ])
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
  expect(JSON.stringify(totals.display)).toBe(JSON.stringify(fixture.payload.display))
  expect(JSON.stringify(totals.taxByRate)).toBe(JSON.stringify(fixture.payload.taxByRate))
  expect(metadata.tally_session_id).toBe(fixture.payload.sessionId)
  expect(metadata.tally_customer_id).toBe(fixture.payload.customer.customerId)
  expect(customer_id).toBe(fixture.payload.customer.customerId)
})
