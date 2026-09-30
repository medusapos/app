import { fiscalFiguresErrors, type OrderCreatePayloadV3 } from '../fiscal-figures'

const payload: OrderCreatePayloadV3 = {
  clientOrderId: 'order_1', createdAt: '2026-09-28T10:00:00Z', currency: 'EUR', pricesIncludeTax: true,
  lines: [{ clientLineId: 'line_1', variantId: 'variant_1', quantity: 1, unitPriceMinor: 1000 }],
  subtotalMinor: 840, taxMinor: 160, totalMinor: 1000,
  payments: [{ clientPaymentId: 'payment_1', method: 'cash', amountMinor: 1000 }],
  display: {
    currency: 'EUR', exponent: 2, taxInclusive: true, subtotalMinor: 1000, discountMinor: 0,
    taxMinor: 160, totalMinor: 1000, orderDiscountMinor: 0,
    lines: [{ clientLineId: 'line_1', amountMinor: 1000, discounts: [] }],
  },
  taxByRate: [{ ratePpm: 190000, code: 'VAT', netMinor: 840, taxMinor: 160, grossMinor: 1000 }],
}

it('accepts a discount-free v3 and a discounted v3', () => {
  expect(fiscalFiguresErrors(payload)).toEqual([])
  const discounted = structuredClone(payload)
  discounted.discountMinor = discounted.lines[0].discountMinor = 100
  discounted.totalMinor = discounted.display!.totalMinor = discounted.display!.lines[0].amountMinor = 900
  discounted.taxMinor = discounted.display!.taxMinor = 144
  discounted.subtotalMinor = 756
  discounted.payments[0].amountMinor = 900
  discounted.display!.discountMinor = 100
  discounted.display!.lines[0].discounts = [{ discountId: 'discount_1', label: 'Sale', amountMinor: 100 }]
  discounted.taxByRate = [{ ratePpm: 190000, netMinor: 756, taxMinor: 144, grossMinor: 900 }]
  expect(fiscalFiguresErrors(discounted)).toEqual([])
})

it('an unsupported currency adds no exponent error, leaving it to the planner', () => {
  expect(fiscalFiguresErrors({ ...payload, currency: 'INVALID', display: { ...payload.display!, currency: 'INVALID' } })).toEqual([])
})

it('caps its errors at 10', () => {
  const taxByRate = Array.from({ length: 12 }, () => ({ ...payload.taxByRate![0], grossMinor: 999 }))
  expect(fiscalFiguresErrors({ ...payload, taxMinor: 1920, display: { ...payload.display!, taxMinor: 1920 }, taxByRate }))
    .toEqual(Array.from({ length: 10 }, (_, index) => `payload.taxByRate[${index}].grossMinor: expected netMinor + taxMinor`))
})

it.each([
  ['currency', 'USD', 'payload.currency'], ['totalMinor', 999, 'payload.totalMinor'],
  ['taxMinor', 159, 'payload.taxMinor'], ['exponent', 3, 'the currency decimals'],
])('rejects inconsistent display.%s', (field, value, expected) => {
  expect(fiscalFiguresErrors({ ...payload, display: { ...payload.display!, [field]: value } }))
    .toEqual([`payload.display.${field}: expected ${expected}`])
})

it('rejects a taxByRate tax sum different from payload.taxMinor', () => {
  const taxByRate = [
    { ratePpm: 190000, netMinor: 420, taxMinor: 80, grossMinor: 500 },
    { ratePpm: 190000, netMinor: 420, taxMinor: 79, grossMinor: 499 },
  ]
  expect(fiscalFiguresErrors({ ...payload, taxByRate }))
    .toEqual(['payload.taxByRate: expected the sum of taxMinor to equal payload.taxMinor'])
})

it('rejects grossMinor different from netMinor plus taxMinor', () => {
  expect(fiscalFiguresErrors({ ...payload, taxByRate: [{ ...payload.taxByRate![0], grossMinor: 999 }] }))
    .toEqual(['payload.taxByRate[0].grossMinor: expected netMinor + taxMinor'])
})

it('rejects an unknown clientLineId', () => {
  const display = { ...payload.display!, lines: [{ clientLineId: 'unknown', amountMinor: 1000, discounts: [] }] }
  expect(fiscalFiguresErrors({ ...payload, display })).toEqual(['payload.display.lines[0].clientLineId: expected a payload.lines[].clientLineId'])
})

it('rejects a duplicate clientLineId', () => {
  const display = { ...payload.display!, lines: [payload.display!.lines[0], payload.display!.lines[0]] }
  expect(fiscalFiguresErrors({ ...payload, display })).toEqual(['payload.display.lines[1].clientLineId: expected no duplicate clientLineId'])
})

it('rejects unknown keys in display, its lines, their discounts, and taxByRate entries', () => {
  for (const path of ['display', 'display.lines[0]', 'display.lines[0].discounts[0]', 'taxByRate[0]']) {
    const input = structuredClone(payload)
    input.display!.lines[0].discounts = [{ discountId: 'discount_1', amountMinor: 0 }]
    const target = path === 'display' ? input.display! : path === 'display.lines[0]' ? input.display!.lines[0]
      : path === 'taxByRate[0]' ? input.taxByRate![0] : input.display!.lines[0].discounts[0]
    Object.assign(target, { unknown: true })
    expect(fiscalFiguresErrors(input)).toEqual([`payload.${path}.unknown: expected no unknown key`])
  }
})

it.each([1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '100', null, undefined])('rejects non-integer and unsafe-integer money %p', value => {
  const input = structuredClone(payload)
  const display = input.display! as unknown as Record<string, unknown>
  for (const field of ['subtotalMinor', 'discountMinor', 'taxMinor', 'totalMinor', 'orderDiscountMinor']) display[field] = value
  Object.assign(input.display!.lines[0], { amountMinor: value, discounts: [{ discountId: 'd', amountMinor: value }] })
  Object.assign(input.taxByRate![0], { netMinor: value, taxMinor: value, grossMinor: value })
  expect(fiscalFiguresErrors(input)).toEqual([
    ...['subtotalMinor', 'discountMinor', 'taxMinor', 'totalMinor', 'orderDiscountMinor'].map(field => `payload.display.${field}: expected a safe integer`),
    'payload.display.lines[0].amountMinor: expected a safe integer', 'payload.display.lines[0].discounts[0].amountMinor: expected a safe integer',
    ...['netMinor', 'taxMinor', 'grossMinor'].map(field => `payload.taxByRate[0].${field}: expected a safe integer`),
  ])
})

it.each([
  ['display', null], ['display.currency', 1], ['display.exponent', -1], ['display.exponent', 1.5],
  ['display.taxInclusive', 'true'], ['display.lines', {}], ['display.lines.0', null],
  ['display.lines.0.clientLineId', 1], ['display.lines.0.discounts', null],
  ['display.lines.0.discounts.0', null], ['display.lines.0.discounts.0.discountId', 1],
  ['display.lines.0.discounts.0.label', 1], ['taxByRate', {}], ['taxByRate.0', null],
  ['taxByRate.0.ratePpm', 1.5], ['taxByRate.0.code', 1],
])('rejects invalid shape at %s (%p)', (path, value) => {
  const input = structuredClone(payload)
  input.display!.lines[0].discounts = [{ discountId: 'd', amountMinor: 0 }]
  const keys = (path as string).split('.')
  const target = keys.slice(0, -1).reduce((object, key) => object[key], input as any)
  target[keys[keys.length - 1]] = value
  expect(fiscalFiguresErrors(input)).toEqual([expect.stringContaining(`payload.${(path as string).replace(/\.(\d+)/g, '[$1]')}: expected`)])
})

it('allows an empty taxByRate only for zero tax and uses currency-specific decimals', () => {
  expect(fiscalFiguresErrors({ ...payload, taxByRate: [] })).toContain('payload.taxByRate: expected a non-empty array when payload.taxMinor is nonzero')
  for (const [currency, exponent] of [['JPY', 0], ['BHD', 3]] as const) {
    const input = { ...payload, currency, taxMinor: 0, taxByRate: [], display: { ...payload.display!, currency, exponent, taxMinor: 0 } }
    expect(fiscalFiguresErrors(input)).toEqual([])
    expect(fiscalFiguresErrors({ ...input, display: { ...input.display, exponent: 2 } })).toEqual(['payload.display.exponent: expected the currency decimals'])
  }
})
