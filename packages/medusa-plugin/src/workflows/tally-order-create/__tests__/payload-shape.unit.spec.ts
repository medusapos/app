import type { OrderCreatePayload } from '@tallyui/core' with { 'resolution-mode': 'import' }
import { payloadNulErrors, payloadShapeErrors } from '../payload-shape'
import { clientTimeStageErrors } from '../../client-time'

const payload: OrderCreatePayload = {
  clientOrderId: 'order_1', createdAt: '2026-09-23T10:00:00Z', currency: 'EUR', pricesIncludeTax: true,
  lines: [{ clientLineId: 'line_1', variantId: 'variant_1', title: 'Coffee', quantity: 1, unitPriceMinor: 1000 }],
  subtotalMinor: 840, taxMinor: 160, totalMinor: 1000,
  payments: [{ clientPaymentId: 'payment_1', method: 'cash', amountMinor: 1000 }], customer: null,
}

it('accepts a payload shaped like toOrderCreateEnvelope output with customer null', () => {
  expect(payloadShapeErrors(payload)).toEqual([])
})

it('accepts every optional field', () => {
  expect(payloadShapeErrors({
    ...payload, customer: { email: 'buyer@example.com' }, registerId: 'register_1', cashierRef: 'cashier_1',
    locationId: 'location_1', payments: [{ ...payload.payments[0], tenderedMinor: 1200, changeMinor: 200, reference: 'receipt' }],
  })).toEqual([])
})

it.each([true, false, undefined])('accepts lines[0].taxInclusive %s, and its absence', taxInclusive => {
  expect('taxInclusive' in payload.lines[0]).toBe(false)
  expect(payloadShapeErrors(payload)).toEqual([])
  expect(payloadShapeErrors({ ...payload, lines: [{ ...payload.lines[0], taxInclusive }] })).toEqual([])
})

it.each([undefined, null, {}, { email: '' }])('accepts optional customer %j', customer => {
  expect(payloadShapeErrors({ ...payload, customer })).toEqual([])
})

it('leaves value rules to the planner and accepts absent optional fields and empty payments', () => {
  expect(payloadShapeErrors({
    ...payload, currency: '', subtotalMinor: -1, taxMinor: 0.5, totalMinor: Number.MAX_VALUE,
    lines: [{ clientLineId: '', variantId: '', quantity: -0.5, unitPriceMinor: -1 }], payments: [],
  })).toEqual([])
  expect(payloadShapeErrors({ ...payload, payments: [{ clientPaymentId: '', method: 'custom', amountMinor: -1 }] })).toEqual([])
})

it.each([undefined, null, [], 'payload', 1, true])('rejects non-object payload %j', value => {
  expect(payloadShapeErrors(value)).toEqual(['payload: expected an object'])
})

it.each([
  ['clientOrderId', '', 'a non-empty string'], ['clientOrderId', 1, 'a non-empty string'],
  ['createdAt', undefined, 'a string'], ['currency', 1, 'a string'],
  ['pricesIncludeTax', 'true', 'a boolean'], ['lines', undefined, 'a non-empty array'],
  ['lines', [], 'a non-empty array'], ['lines', {}, 'a non-empty array'],
  ['payments', undefined, 'an array'], ['customer', 'buyer', 'an object'], ['customer', [], 'an object'],
  ['subtotalMinor', NaN, 'a finite number'], ['taxMinor', Infinity, 'a finite number'],
  ['totalMinor', -Infinity, 'a finite number'], ['registerId', 1, 'a string'],
  ['cashierRef', null, 'a string'], ['locationId', false, 'a string'],
])('rejects invalid %s (%j)', (field, value, expected) => {
  expect(payloadShapeErrors({ ...payload, [field as string]: value })).toEqual([`payload.${field}: expected ${expected}`])
})

it.each([
  ['lines', 'clientLineId', undefined, 'a string'], ['lines', 'variantId', 1, 'a string'],
  ['lines', 'title', null, 'a string'], ['lines', 'quantity', '1', 'a finite number'],
  ['lines', 'unitPriceMinor', Infinity, 'a finite number'],
  ['lines', 'taxInclusive', 'false', 'a boolean'], ['lines', 'taxInclusive', null, 'a boolean'],
  ['lines', 'taxInclusive', 0, 'a boolean'],
  ['payments', 'clientPaymentId', undefined, 'a string'], ['payments', 'method', undefined, 'a string'],
  ['payments', 'amountMinor', '1000', 'a finite number'], ['payments', 'tenderedMinor', NaN, 'a finite number'],
  ['payments', 'changeMinor', null, 'a finite number'], ['payments', 'reference', 1, 'a string'],
])('rejects invalid %s[0].%s', (field: string, key: string, value, expected: string) => {
  const item = { ...payload[field][0], [key]: value }
  expect(payloadShapeErrors({ ...payload, [field]: [item] })).toEqual([`payload.${field}[0].${key}: expected ${expected}`])
})

it.each(['lines', 'payments'])('rejects non-object entries in %s', field => {
  for (const item of [null, [], 'item']) {
    expect(payloadShapeErrors({ ...payload, [field]: [item] })).toEqual([`payload.${field}[0]: expected an object`])
  }
})

it.each(['2019-12-31T23:59:59.999Z', 'late', 'invalid', ''])('leaves payload.createdAt %p format and bounds to the client-time stage', value => {
  const createdAt = value === 'late' ? new Date(Date.now() + 24 * 60 * 60 * 1000 + 60000).toISOString() : value
  expect(payloadShapeErrors({ ...payload, createdAt })).toEqual([])
  if (value === 'invalid' || value === '') expect(clientTimeStageErrors({ type: 'order.create',
    payload: { ...payload, createdAt } } as never, Date.now())).toEqual(['payload.createdAt must be an RFC 3339 time with Z or an offset'])
})

it('rejects a non-string customer email', () => {
  expect(payloadShapeErrors({ ...payload, customer: { email: 1 } })).toEqual(['payload.customer.email: expected a string'])
})

describe('discountMinor (ADR-062)', () => {
  const line = payload.lines[0]
  const lines = [{ ...line, discountMinor: 100 }, { ...line, clientLineId: 'line_2' }, { ...line, clientLineId: 'line_3', discountMinor: 25 }]

  it('accepts line discounts whose sum is the payload discount', () => {
    expect(payloadShapeErrors({ ...payload, lines, discountMinor: 125 })).toEqual([])
  })

  it.each([[124], [126], [undefined]])('rejects a payload discount of %j for lines summing to 125', discountMinor => {
    expect(payloadShapeErrors({ ...payload, lines, discountMinor })).toEqual(['payload.discountMinor: expected the sum of payload.lines[].discountMinor'])
  })

  it('rejects a payload discount without line discounts', () => {
    expect(payloadShapeErrors({ ...payload, discountMinor: 1 })).toEqual(['payload.discountMinor: expected the sum of payload.lines[].discountMinor'])
  })

  it.each([0, -1, 1.5, NaN, '100', null, Number.MAX_SAFE_INTEGER + 1])('rejects discountMinor %j on a line and on the payload', value => {
    expect(payloadShapeErrors({ ...payload, lines: [{ ...line, discountMinor: value }], discountMinor: 1 }))
      .toEqual(['payload.lines[0].discountMinor: expected a positive safe integer'])
    expect(payloadShapeErrors({ ...payload, lines: [{ ...line, discountMinor: 1 }], discountMinor: value }))
      .toEqual(['payload.discountMinor: expected a positive safe integer'])
  })
})

describe('lines[].clientLineId', () => {
  const lines = (...ids: string[]) => ids.map(clientLineId => ({ ...payload.lines[0], clientLineId }))

  it('refuses a repeated id once, at its second occurrence, naming both indexes', () => {
    expect(payloadShapeErrors({ ...payload, lines: lines('A', 'A') })).toEqual(['payload.lines[1].clientLineId: expected no duplicate of payload.lines[0].clientLineId'])
    expect(payloadShapeErrors({ ...payload, lines: lines('A', 'B', 'A') })).toEqual(['payload.lines[2].clientLineId: expected no duplicate of payload.lines[0].clientLineId'])
    expect(payloadShapeErrors({ ...payload, lines: lines('A', 'B', 'A', 'A') })).toEqual(['payload.lines[2].clientLineId: expected no duplicate of payload.lines[0].clientLineId'])
  })

  it('accepts unique ids', () => {
    expect(payloadShapeErrors({ ...payload, lines: lines('A', 'B', 'C') })).toEqual([])
  })

  it('reports at most ten duplicates', () => {
    const errors = payloadShapeErrors({ ...payload, lines: lines(...Array.from({ length: 12 }, (_, index) => [`${index}`, `${index}`]).flat()) })
    expect(errors).toHaveLength(10)
    expect(errors[9]).toBe('payload.lines[19].clientLineId: expected no duplicate of payload.lines[18].clientLineId')
  })
})

it('reports at most ten errors', () => {
  const errors = payloadShapeErrors({ lines: [{}, {}, {}], payments: [{}] })
  expect(errors).toHaveLength(10)
  expect(errors.every(error => /^.+: expected /u.test(error))).toBe(true)
})

it.each(['session-unknown', '12345678-1234-1234-1234-123456789012'])('accepts sessionId %s without a lookup', sessionId => {
  expect(payloadShapeErrors({ ...payload, sessionId })).toEqual([])
})

it.each(['x'.repeat(37), '', null, 1])('rejects invalid sessionId %p', sessionId => {
  expect(payloadShapeErrors({ ...payload, sessionId })).toEqual(['payload.sessionId: expected a string of at most 36 characters'])
})

it.each([{ customerId: 'customer' }, { customerId: 'x'.repeat(64), email: 'buyer@example.com' }])('accepts customerId with optional email %j', customer => {
  expect(payloadShapeErrors({ ...payload, customer })).toEqual([])
})

it.each(['x'.repeat(65), '', null, 1])('rejects invalid customerId %p', customerId => {
  expect(payloadShapeErrors({ ...payload, customer: { customerId } }))
    .toEqual(['payload.customer.customerId: expected a string of at most 64 characters'])
})

it.each([
  ['extra', { extra: true }],
  ['constructor', { constructor: 1 }],
  ['lines[0].discountMinr', { lines: [{ ...payload.lines[0], discountMinr: 100 }] }],
  ['payments[0].extra', { payments: [{ ...payload.payments[0], extra: true }] }],
  ['customer.extra', { customer: { email: 'buyer@example.com', extra: true } }],
])('refuses the unknown field %s, naming its path (ruling 17)', (path, fields) => {
  expect(payloadShapeErrors({ ...payload, ...fields }, 1)).toEqual([`payload.${path}: unknown field for order.create version 1`])
})

it('knows each field from the version that declares it', () => {
  const line = { ...payload.lines[0], discountMinor: 1 }
  const v2 = { ...payload, lines: [line], discountMinor: 1 }
  const v3 = { ...v2, sessionId: 'session', customer: { email: 'buyer@example.com', customerId: 'customer' } }
  expect(payloadShapeErrors(v2, 2)).toEqual([])
  expect(payloadShapeErrors(v3, 3)).toEqual([])
  expect(payloadShapeErrors(v2, 1)).toEqual(['payload.discountMinor: requires version 2', 'payload.lines[0].discountMinor: requires version 2'])
  expect(payloadShapeErrors(v3, 2)).toEqual(['payload.sessionId: requires version 3', 'payload.customer.customerId: requires version 3'])
  expect(payloadShapeErrors({ ...payload, display: {}, taxByRate: [] }, 1))
    .toEqual(['payload.display: requires version 3', 'payload.taxByRate: requires version 3'])
})

it('reports at most ten unknown fields', () => {
  const extra = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`extra${index}`, index]))
  expect(payloadShapeErrors({ ...payload, ...extra }, 1)).toHaveLength(10)
})

it.each([
  ['clientOrderId', 255], ['createdAt', 255], ['currency', 255],
  ['lines.0.clientLineId', 255], ['lines.0.variantId', 255], ['lines.0.title', 255],
  ['payments.0.clientPaymentId', 255], ['payments.0.method', 255], ['payments.0.reference', 255],
  ['registerId', 255], ['cashierRef', 255], ['locationId', 255], ['customer.email', 254],
  ['customer.customerId', 64], ['sessionId', 36],
] as const)('checks the exact string bound for %s (%i)', (field, max) => {
  const value = { ...structuredClone(payload), customer: {} }
  const keys = field.split('.')
  const key = keys.pop()!
  const target = keys.reduce((object, part) => object[part], value as any)
  target[key] = 'x'.repeat(max)
  expect(payloadShapeErrors(value)).toEqual([])
  target[key] += 'x'
  const expected = max === 64 || max === 36 ? `a string of at most ${max} characters` : `at most ${max} characters`
  expect(payloadShapeErrors(value)).toEqual([`payload.${field.replace('.0.', '[0].')}: expected ${expected}`])
})

it.each([
  ['clientOrderId', { clientOrderId: 'order\0id' }],
  ['lines[0].title', { lines: [{ ...payload.lines[0], title: 'cof\0fee' }] }],
  ['customer.email', { customer: { email: 'buyer\0@example.com' } }],
  ['sessionId', { sessionId: 'session\0id' }],
])('rejects NUL in %s', (field, fields) => {
  const value = { ...payload, ...fields as object }
  expect(payloadShapeErrors(value)).toEqual([`payload.${field}: expected no NUL character`])
  expect(payloadNulErrors(value)).toEqual([`payload.${field}: expected no NUL character`])
})

it('reports only NUL errors independently of shape and bounds', () => {
  expect(payloadNulErrors({ lines: [{ title: 'x'.repeat(256) }] })).toEqual([])
  expect(payloadNulErrors({ lines: [{ title: 'x'.repeat(256) + '\0' }] }))
    .toEqual(['payload.lines[0].title: expected no NUL character'])
  const value = { ...payload, lines: Array.from({ length: 12 }, (_, index) => ({ ...payload.lines[0], clientLineId: `line_${index}`, title: '\0' })) }
  expect(payloadNulErrors(value)).toHaveLength(10)
  expect(payloadShapeErrors(value)).toEqual(payloadNulErrors(value))
})

it.each([null, 'payload', { lines: 5 }])('NUL checking never throws on %j', value => {
  expect(() => payloadNulErrors(value)).not.toThrow()
  expect(payloadNulErrors(value)).toEqual([])
})
