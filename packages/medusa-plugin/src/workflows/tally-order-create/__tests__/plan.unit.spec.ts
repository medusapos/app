import type { OrderCreatePayload } from '@tallyui/core'
import { fulfillmentGroups, planOrderCreate, totalWarnings } from '../plan'
import type { PlanContext } from '../plan'

const payload: OrderCreatePayload = {
  clientOrderId: 'client_order', createdAt: '2026-09-23T10:00:00Z', currency: 'EUR',
  pricesIncludeTax: true,
  lines: [
    { clientLineId: 'line_1', variantId: 'variant_1', title: 'First', quantity: 2, unitPriceMinor: 850 },
    { clientLineId: 'line_2', variantId: 'variant_2', quantity: 1, unitPriceMinor: 5 },
  ],
  subtotalMinor: 1409, taxMinor: 296, totalMinor: 1705,
  payments: [{ clientPaymentId: 'payment_1', method: 'cash', amountMinor: 1705, tenderedMinor: 2000, changeMinor: 295 }],
  customer: { email: 'buyer@example.com' }, registerId: 'register_1', cashierRef: 'cashier_1',
  locationId: 'client_location',
}
const ctx: PlanContext = {
  commandId: 'command_1', region: { id: 'region_1', currency_code: 'eUr', country_codes: ['ES', 'fr'] },
  salesChannelId: 'channel_1',
  location: {
    id: 'location_1',
    address: { address_1: '1 Main St', address_2: null, city: 'Madrid', country_code: 'Es', province: 'Madrid', postal_code: '28001', phone: '123' },
  },
  variants: { variant_1: { id: 'variant_1' }, variant_2: { id: 'variant_2' } },
}

it('produces the exact EUR tax-inclusive draft plan without mutating its inputs', () => {
  const before = JSON.stringify({ payload, ctx })
  const result = planOrderCreate(payload, ctx)
  const address = { ...ctx.location.address, country_code: 'es' }
  expect(result).toEqual({
    ok: true,
    plan: {
      currencyCode: 'eur', decimals: 2, locationId: 'location_1', paymentAmount: '17.05',
      draftOrder: {
        status: 'draft', is_draft_order: true, region_id: 'region_1', sales_channel_id: 'channel_1', currency_code: 'eur',
        email: 'buyer@example.com', shipping_address: address, billing_address: address, no_notification: true,
        metadata: {
          tally_client_id: 'client_order', tally_created_at: '2026-09-23T10:00:00Z', tally_command_id: 'command_1',
          tally_payments: payload.payments, tally_register_id: 'register_1', tally_cashier_ref: 'cashier_1',
        },
        items: [
          { variant_id: 'variant_1', quantity: 2, unit_price: '8.50', is_tax_inclusive: true, metadata: { tally_line_uuid: 'line_1' } },
          { variant_id: 'variant_2', quantity: 1, unit_price: '0.05', is_tax_inclusive: true, metadata: { tally_line_uuid: 'line_2' } },
        ],
      },
    },
  })
  if (!result.ok) throw new Error('Expected a plan')
  expect(result.plan.draftOrder.shipping_address).not.toBe(ctx.location.address)
  expect(result.plan.draftOrder.billing_address).not.toBe(ctx.location.address)
  expect(result.plan.draftOrder.metadata.tally_payments).toBe(payload.payments)
  expect(JSON.stringify({ payload, ctx })).toBe(before)
})

it('keeps tax-exclusive prices', () => {
  const result = planOrderCreate({ ...payload, pricesIncludeTax: false }, ctx)
  if (!result.ok) throw new Error('Expected a plan')
  expect(result.plan.draftOrder.items.map(item => item.is_tax_inclusive)).toEqual([false, false])
})

it.each([undefined, null, {}, { email: '' }])('omits email for customer %j', customer => {
  const result = planOrderCreate({ ...payload, customer }, ctx)
  if (!result.ok) throw new Error('Expected a plan')
  expect(result.plan.draftOrder).not.toHaveProperty('email')
})

it('omits absent register and cashier metadata', () => {
  const { registerId, cashierRef, ...withoutOptionalMetadata } = payload
  const result = planOrderCreate(withoutOptionalMetadata, ctx)
  if (!result.ok) throw new Error('Expected a plan')
  expect(result.plan.draftOrder.metadata).not.toHaveProperty('tally_register_id')
  expect(result.plan.draftOrder.metadata).not.toHaveProperty('tally_cashier_ref')
})

it('keeps present empty register and cashier metadata', () => {
  const result = planOrderCreate({ ...payload, registerId: '', cashierRef: '' }, ctx)
  if (!result.ok) throw new Error('Expected a plan')
  expect(result.plan.draftOrder.metadata).toMatchObject({ tally_register_id: '', tally_cashier_ref: '' })
})

it('rejects empty lines', () => {
  expect(planOrderCreate({ ...payload, lines: [] }, ctx)).toEqual({
    ok: false, rejection: { code: 'invalid_quantity', message: expect.stringContaining('lines') },
  })
})

const numericFields = [
  'lines[1].quantity', 'lines[1].unitPriceMinor', 'subtotalMinor', 'taxMinor', 'totalMinor',
  'payments[1].amountMinor', 'payments[1].tenderedMinor', 'payments[1].changeMinor',
]
describe.each(numericFields)('%s validation', field => {
  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects %s and names the field', value => {
    const input: OrderCreatePayload = {
      ...payload, lines: payload.lines.map(line => ({ ...line })),
      payments: [payload.payments[0], { ...payload.payments[0] }],
    }
    if (field.startsWith('lines')) input.lines[1][field.split('.')[1]] = value
    else if (field.startsWith('payments')) input.payments[1][field.split('.')[1]] = value
    else input[field] = value
    expect(planOrderCreate(input, ctx)).toEqual({
      ok: false, rejection: { code: 'invalid_quantity', message: expect.stringContaining(field) },
    })
  })
})

it('rejects zero quantity', () => {
  const lines = [{ ...payload.lines[0], quantity: 0 }]
  expect(planOrderCreate({ ...payload, lines }, ctx)).toEqual({
    ok: false, rejection: { code: 'invalid_quantity', message: expect.stringContaining('lines[0].quantity') },
  })
})

it('accepts zero price, totals and payment amounts', () => {
  const result = planOrderCreate({
    ...payload, lines: [{ ...payload.lines[0], unitPriceMinor: 0 }], subtotalMinor: 0, taxMinor: 0, totalMinor: 0,
    payments: [{ ...payload.payments[0], amountMinor: 0, tenderedMinor: 0, changeMinor: 0 }],
  }, ctx)
  if (!result.ok) throw new Error('Expected a plan')
  expect(result.plan.paymentAmount).toBe('0.00')
  expect(result.plan.draftOrder.items[0].unit_price).toBe('0.00')
})

it.each([
  ['currency mismatch', { ...payload, currency: 'USD' }, ctx],
  ['Intl rejection', { ...payload, currency: 'BOGUS' }, { ...ctx, region: { ...ctx.region, currency_code: 'BOGUS' } }],
  ['country outside region', payload, { ...ctx, location: { ...ctx.location, address: { country_code: 'US' } } }],
])('rejects unsupported currency: %s', (_name, input, context) => {
  expect(planOrderCreate(input as OrderCreatePayload, context as PlanContext)).toEqual({
    ok: false, rejection: { code: 'unsupported_currency', message: expect.any(String) },
  })
})

it.each([['JPY', 0, '1705', '850'], ['BHD', 3, '1.705', '0.850']] as const)(
  'plans %s with its currency exponent', (currency, decimals, paymentAmount, unitPrice) => {
    const result = planOrderCreate({ ...payload, currency }, { ...ctx, region: { ...ctx.region, currency_code: currency } })
    if (!result.ok) throw new Error('Expected a plan')
    expect(result.plan).toMatchObject({ decimals, currencyCode: currency.toLowerCase(), paymentAmount })
    expect(result.plan.draftOrder.items[0].unit_price).toBe(unitPrice)
  }
)

it('lists all unknown variant ids', () => {
  const result = planOrderCreate(payload, { ...ctx, variants: {} })
  expect(result).toMatchObject({ ok: false, rejection: { code: 'unknown_variant' } })
  if (result.ok) throw new Error('Expected rejection')
  expect(result.rejection.message).toContain('variant_1')
  expect(result.rejection.message).toContain('variant_2')
})

it('does not treat inherited keys as known variant ids', () => {
  const lines = [{ ...payload.lines[0], variantId: 'toString' }]
  expect(planOrderCreate({ ...payload, lines }, ctx)).toMatchObject({ ok: false, rejection: { code: 'unknown_variant' } })
})

it.each([{ payments: [] }, { payments: [{ ...payload.payments[0], amountMinor: 1704, tenderedMinor: 2000 }] }])(
  'rejects underpayment using amountMinor, including empty payments', ({ payments }) => {
    expect(planOrderCreate({ ...payload, payments }, ctx)).toMatchObject({ ok: false, rejection: { code: 'underpaid' } })
  }
)

it('accepts overpayment but collects exactly totalMinor', () => {
  const result = planOrderCreate({ ...payload, payments: [{ ...payload.payments[0], amountMinor: 2000 }] }, ctx)
  if (!result.ok) throw new Error('Expected a plan')
  expect(result.plan.paymentAmount).toBe('17.05')
})

it.each([704, 705, 800])('sums multiple payments (1000 + %s)', amountMinor => {
  const payments: OrderCreatePayload['payments'] = [
    { clientPaymentId: 'p1', method: 'cash', amountMinor: 1000 },
    { clientPaymentId: 'p2', method: 'external', amountMinor, reference: 'receipt_2' },
  ]
  const result = planOrderCreate({ ...payload, payments }, ctx)
  if (amountMinor < 705) expect(result).toMatchObject({ ok: false, rejection: { code: 'underpaid' } })
  else {
    if (!result.ok) throw new Error('Expected a plan')
    expect(result.plan.paymentAmount).toBe('17.05')
    expect(result.plan.draftOrder.metadata.tally_payments).toEqual(payments)
  }
})

it.each([
  ['invalid_quantity', { ...payload, lines: [], currency: 'USD', payments: [] }],
  ['unsupported_currency', { ...payload, currency: 'USD', payments: [] }],
  ['unknown_variant', { ...payload, payments: [] }],
])('gives %s precedence over later failures', (code, input) => {
  expect(planOrderCreate(input as OrderCreatePayload, { ...ctx, variants: {} })).toMatchObject({ ok: false, rejection: { code } })
})

const shipping1 = { id: 's1', quantity: 2, requires_shipping: true }
const shipping2 = { id: 's2', quantity: 1, requires_shipping: true }
const digital1 = { id: 'd1', quantity: 3, requires_shipping: false }
const digital2 = { id: 'd2', quantity: 4, requires_shipping: false }
it.each([
  [[], []],
  [[shipping1, shipping2], [[{ id: 's1', quantity: 2 }, { id: 's2', quantity: 1 }]]],
  [[digital1, digital2], [[{ id: 'd1', quantity: 3 }, { id: 'd2', quantity: 4 }]]],
  [[digital1, shipping1, digital2, shipping2], [
    [{ id: 's1', quantity: 2 }, { id: 's2', quantity: 1 }],
    [{ id: 'd1', quantity: 3 }, { id: 'd2', quantity: 4 }],
  ]],
])('groups fulfillment items %j', (items, expected) => {
  expect(fulfillmentGroups(items as typeof shipping1[])).toEqual(expected)
})

it('has no warning for equal totals', () => {
  expect(totalWarnings(1705, 1705)).toEqual([])
})

it.each([1704, 1706])('warns for server total %s', serverMinor => {
  expect(totalWarnings(1705, serverMinor)).toEqual([{ code: 'total_mismatch', expectedMinor: 1705, serverMinor }])
})
