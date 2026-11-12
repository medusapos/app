import type { OrderCreatePayload } from '@tallyui/core' with { 'resolution-mode': 'import' }
import { payloadNulErrors, payloadShapeErrors } from '../payload-shape'
import { clientTimeStageErrors } from '../../client-time'
import feeGolden from '../__fixtures__/order-create-v5-fee.json'
import shippingGolden from '../__fixtures__/order-create-v5-shipping-custom.json'
import v3Golden from '../__fixtures__/order-create-v3.json'

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

it('version 5: the fee and shipping+custom golden pairs have no shape errors', () => {
  for (const fixture of [feeGolden, shippingGolden]) expect(payloadShapeErrors(fixture.payload, fixture.version)).toEqual([])
})

it('below version 5, fees, shipping and lines[].custom are named "requires version 5"', () => {
  const value = { ...payload, fees: feeGolden.payload.fees, shipping: shippingGolden.payload.shipping, lines: shippingGolden.payload.lines }
  for (const version of [1, 2, 3, 4]) expect(payloadShapeErrors(value, version)).toEqual(expect.arrayContaining([
    'payload.fees: requires version 5', 'payload.shipping: requires version 5', 'payload.lines[1].custom: requires version 5',
  ]))
})

it('a custom line with a variantId, and a non-custom line without one, are refused naming the line', () => {
  const { variantId, ...line } = payload.lines[0]
  expect(payloadShapeErrors({ ...payload, lines: [line, { ...shippingGolden.payload.lines[1], variantId }] }, 5)).toEqual([
    'payload.lines[0].variantId: expected a string', 'payload.lines[1].variantId: expected no variantId on a custom line',
  ])
})

it('a fee or shipping amountMinor that is negative or not an integer, an unknown taxStatus, an unknown fee key, and a duplicate clientFeeId are refused', () => {
  for (const [field, charge, id] of [['fees', feeGolden.payload.fees[0], 'clientFeeId'], ['shipping', shippingGolden.payload.shipping[0], 'clientShippingId']] as const) {
    for (const key of ['amountMinor', 'taxMinor']) for (const amount of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '1', null]) {
      expect(payloadShapeErrors({ ...payload, [field]: [{ ...charge, [key]: amount }] }, 5))
        .toEqual([`payload.${field}[0].${key}: expected a non-negative safe integer`])
    }
    expect(payloadShapeErrors({ ...payload, [field]: [{ ...charge, taxStatus: 'exempt' }] }, 5))
      .toEqual([`payload.${field}[0].taxStatus: expected 'taxable' or 'none'`])
    expect(payloadShapeErrors({ ...payload, [field]: [charge, charge, charge] }, 5))
      .toEqual([`payload.${field}[1].${id}: expected no duplicate of payload.${field}[0].${id}`])
    expect(payloadShapeErrors({ ...payload, [field]: [{ ...charge, amountMinor: 0, taxMinor: 0 }] }, 5)).toEqual([])
  }
  expect(payloadShapeErrors({ ...feeGolden.payload, fees: [{ ...feeGolden.payload.fees[0], extra: true }] }, 5))
    .toEqual(['payload.fees[0].extra: unknown field for order.create version 5'])
})

it('checks v5 string types, bounds and NUL, including optional empty strings', () => {
  const value = { ...structuredClone(shippingGolden.payload), fees: structuredClone(feeGolden.payload.fees) }
  for (const [prefix, entry, keys] of [
    ['fees[0]', value.fees[0], ['clientFeeId', 'name', 'taxClass']],
    ['shipping[0]', value.shipping[0], ['clientShippingId', 'name', 'taxClass', 'methodId']],
    ['lines[1].custom', value.lines[1].custom!, ['name', 'sku', 'taxClass']],
  ] as const) for (const key of keys) {
    const target = entry as Record<string, unknown>, original = target[key], max = key === 'name' ? 255 : 64
    target[key] = 'x'.repeat(max)
    expect(payloadShapeErrors(value, 5)).toEqual([])
    target[key] = 'x'.repeat(max + 1)
    expect(payloadShapeErrors(value, 5)).toEqual([`payload.${prefix}.${key}: expected at most ${max} characters`])
    target[key] = '\0'
    expect(payloadShapeErrors(value, 5)).toEqual([`payload.${prefix}.${key}: expected no NUL character`])
    expect(payloadNulErrors(value)).toEqual([`payload.${prefix}.${key}: expected no NUL character`])
    target[key] = ''
    const required = key === 'name' || key.startsWith('client')
    expect(payloadShapeErrors(value, 5)).toEqual(required ? [`payload.${prefix}.${key}: expected a non-empty string`] : [])
    target[key] = null
    expect(payloadShapeErrors(value, 5)).toEqual([`payload.${prefix}.${key}: expected ${required ? 'a non-empty string' : 'a string'}`])
    if (original === undefined) delete target[key]
    else target[key] = original
  }
})

it('checks v5 containers, required fields and unknown shipping and custom keys', () => {
  for (const field of ['fees', 'shipping']) for (const value of [null, {}, 'charge']) {
    expect(payloadShapeErrors({ ...payload, [field]: value }, 5)).toEqual([`payload.${field}: expected an array`])
    expect(payloadShapeErrors({ ...payload, [field]: [value === null ? null : 'charge'] }, 5)).toEqual([`payload.${field}[0]: expected an object`])
  }
  for (const custom of [null, [], 'custom']) expect(payloadShapeErrors({ ...payload, lines: [{ clientLineId: 'c', quantity: 1, unitPriceMinor: 1, custom }] }, 5))
    .toEqual(['payload.lines[0].custom: expected an object'])
  expect(payloadShapeErrors({ ...shippingGolden.payload, shipping: [{ ...shippingGolden.payload.shipping[0], extra: true }] }, 5))
    .toEqual(['payload.shipping[0].extra: unknown field for order.create version 5'])
  expect(payloadShapeErrors({ ...payload, lines: [{ clientLineId: 'c', quantity: 1, unitPriceMinor: 1, custom: { extra: true } }] }, 5)).toEqual([
    'payload.lines[0].custom.extra: unknown field for order.create version 5',
    'payload.lines[0].custom.name: expected a non-empty string', "payload.lines[0].custom.taxStatus: expected 'taxable' or 'none'",
  ])
})

describe('versions 6 and 7 (ADR 0024)', () => {
  it('accepts a note at version 7, up to 1000 UTF-16 units, and refuses it below 7 as a later field', () => {
    expect(payloadShapeErrors({ ...payload, note: 'Gift wrap, please' }, 7)).toEqual([])
    expect(payloadShapeErrors({ ...payload, note: 'x'.repeat(1000) }, 7)).toEqual([])
    expect(payloadShapeErrors({ ...payload, note: '😀'.repeat(500) }, 7)).toEqual([])
    expect(payloadShapeErrors({ ...payload, note: 'Gift wrap, please' }, 5)).toEqual(['payload.note: requires version 7'])
    expect(payloadShapeErrors({ ...payload, note: 'Gift wrap, please' }, 6)).toEqual(['payload.note: requires version 7'])
  })

  it('refuses taxAddress at version 7 as requiring version 8', () => {
    expect(payloadShapeErrors({ ...payload, taxAddress: 'billing' }, 7)).toEqual(['payload.taxAddress: requires version 8'])
  })

  it('refuses customer addresses at version 7 as requiring version 8', () => {
    expect(payloadShapeErrors({ ...payload, customer: { email: 'buyer@example.com', billing: { country: 'DE' }, shipping: { country: 'DE' } } }, 7))
      .toEqual(['payload.customer.billing: requires version 8', 'payload.customer.shipping: requires version 8'])
  })

  it.each([['an empty', ''], ['a 1001-unit', 'x'.repeat(1001)], ['a 1002-unit emoji', '😀'.repeat(501)], ['a number', 5], ['a null', null]])(
    'refuses %s note', (_, note) => {
      expect(payloadShapeErrors({ ...payload, note }, 7)).toEqual(['payload.note: expected a string of 1 to 1000 characters'])
    })

  it('refuses a NUL note, before the replay read as well', () => {
    expect(payloadShapeErrors({ ...payload, note: 'gift\0wrap' }, 7)).toEqual(['payload.note: expected no NUL character'])
    expect(payloadNulErrors({ ...payload, note: 'gift\0wrap' })).toEqual(['payload.note: expected no NUL character'])
  })

  const recorded = { ...payload.lines[0], regularUnitPriceMinor: 1200, attributes: { Size: 'M', Colour: 'Blue' }, anyAttributes: ['Colour'] }

  it('accepts the recorded line fields from version 6, and names them "requires version 6" below it', () => {
    expect(payloadShapeErrors({ ...payload, lines: [recorded] }, 6)).toEqual([])
    expect(payloadShapeErrors({ ...payload, lines: [recorded], note: 'n' }, 7)).toEqual([])
    expect(payloadShapeErrors({ ...payload, lines: [{ ...recorded, regularUnitPriceMinor: 0, attributes: {}, anyAttributes: [] }] }, 6)).toEqual([])
    expect(payloadShapeErrors({ ...payload, lines: [recorded] }, 5)).toEqual(['payload.lines[0].regularUnitPriceMinor: requires version 6',
      'payload.lines[0].attributes: requires version 6', 'payload.lines[0].anyAttributes: requires version 6'])
  })

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1200', null])('refuses regularUnitPriceMinor %p', regularUnitPriceMinor => {
    expect(payloadShapeErrors({ ...payload, lines: [{ ...recorded, regularUnitPriceMinor }] }, 6))
      .toEqual(['payload.lines[0].regularUnitPriceMinor: expected a non-negative safe integer'])
  })

  it('bounds an attributes value at 255 characters, and refuses a non-string value, a non-object and NUL', () => {
    expect(payloadShapeErrors({ ...payload, lines: [{ ...recorded, attributes: { Size: 'x'.repeat(255), Colour: 'Blue' } }] }, 6)).toEqual([])
    expect(payloadShapeErrors({ ...payload, lines: [{ ...recorded, attributes: { Size: 'x'.repeat(256), Colour: 'Blue' } }] }, 6))
      .toEqual(['payload.lines[0].attributes.Size: expected at most 255 characters'])
    for (const attributes of [{ Size: 1 }, ['M'], 'M', null]) {
      expect(payloadShapeErrors({ ...payload, lines: [{ ...payload.lines[0], attributes }] }, 6))
        .toEqual(['payload.lines[0].attributes: expected an object of strings'])
    }
    expect(payloadNulErrors({ ...payload, lines: [{ ...recorded, attributes: { Size: 'M\0', Colour: 'Blue' } }] }))
      .toEqual(['payload.lines[0].attributes.Size: expected no NUL character'])
    expect(payloadShapeErrors({ ...payload, lines: [{ ...payload.lines[0], attributes: { 'Si\0ze': 'M' } }] }, 6))
      .toEqual(['payload.lines[0].attributes: expected no NUL character'])
  })

  it('bounds an attributes name at 255 characters', () => {
    expect(payloadShapeErrors({ ...payload, lines: [{ ...recorded, attributes: { ['n'.repeat(255)]: 'M', Colour: 'Blue' } }] }, 6)).toEqual([])
    expect(payloadShapeErrors({ ...payload, lines: [{ ...recorded, attributes: { ['n'.repeat(256)]: 'M', Colour: 'Blue' } }] }, 6))
      .toEqual(['payload.lines[0].attributes: expected at most 255 characters'])
  })

  it('refuses a lone surrogate, before the replay read as well, and accepts a valid pair', () => {
    expect(payloadShapeErrors({ ...payload, note: 'a\uD83D' }, 7)).toEqual(['payload.note: expected well-formed text'])
    expect(payloadNulErrors({ ...payload, note: 'a\uD83D' })).toEqual(['payload.note: expected well-formed text'])
    const lowSurrogate = { ...payload, lines: [{ ...payload.lines[0], title: '\uDE00b' }] }
    expect(payloadShapeErrors(lowSurrogate, 7)).toEqual(['payload.lines[0].title: expected well-formed text'])
    expect(payloadNulErrors(lowSurrogate)).toEqual(['payload.lines[0].title: expected well-formed text'])
    expect(payloadShapeErrors({ ...payload, lines: [{ ...payload.lines[0], title: 'cof😀fee' }] }, 7)).toEqual([])
    expect(payloadNulErrors({ ...payload, lines: [{ ...payload.lines[0], title: 'cof😀fee' }] })).toEqual([])
  })

  it.each([[['Pattern']], [['Colour', 'Pattern']], [[1]], ['Colour'], [null]])('refuses anyAttributes %j, not an array of names in attributes', anyAttributes => {
    expect(payloadShapeErrors({ ...payload, lines: [{ ...recorded, anyAttributes }] }, 6))
      .toEqual(['payload.lines[0].anyAttributes: expected an array of names in attributes'])
  })

  it('refuses anyAttributes on a line without attributes', () => {
    const { attributes, ...line } = recorded
    expect(payloadShapeErrors({ ...payload, lines: [line] }, 6))
      .toEqual(['payload.lines[0].anyAttributes: expected an array of names in attributes'])
  })

  it('accepts coupons as an array from version 6, refuses them at version 5 as a later field, and refuses a non-array', () => {
    const coupons = [{ code: 'SAVE10', couponId: 'c1', discountMinor: 100, discountTaxMinor: 0 }]
    expect(payloadShapeErrors({ ...payload, coupons }, 6)).toEqual([])
    expect(payloadShapeErrors({ ...payload, coupons: [] }, 7)).toEqual([])
    expect(payloadShapeErrors({ ...payload, coupons }, 5)).toEqual(['payload.coupons: requires version 6'])
    for (const value of [{}, 'SAVE10', null]) expect(payloadShapeErrors({ ...payload, coupons: value }, 6)).toEqual(['payload.coupons: expected an array'])
  })
})

describe('version 3 receipt strings (#292)', () => {
  type Set = (value: any, text: string) => void
  const receipt: [string, number, Set][] = [
    ['display.currency', 255, (value, text) => { value.display.currency = text }],
    ['display.lines[0].clientLineId', 255, (value, text) => { value.display.lines[0].clientLineId = text }],
    ['display.lines[0].discounts[0].discountId', 0, (value, text) => { value.display.lines[0].discounts[0].discountId = text }],
    ['display.lines[0].discounts[0].label', 0, (value, text) => { value.display.lines[0].discounts[0].label = text }],
    ['taxByRate[0].code', 0, (value, text) => { value.taxByRate[0].code = text }],
  ]
  const withText = (set: Set, text: string) => {
    const value = structuredClone(v3Golden.payload)
    set(value, text)
    return value
  }

  it('the golden v3 payload has no shape or NUL errors', () => {
    expect(payloadShapeErrors(v3Golden.payload, 3)).toEqual([])
    expect(payloadNulErrors(v3Golden.payload)).toEqual([])
  })

  it.each(receipt)('refuses NUL in %s, before the replay read as well', (field, _max, set) => {
    const value = withText(set, 'a\0b')
    expect(payloadShapeErrors(value, 3)).toEqual([`payload.${field}: expected no NUL character`])
    expect(payloadNulErrors(value)).toEqual([`payload.${field}: expected no NUL character`])
  })

  it.each(receipt)('refuses a lone surrogate in %s, and accepts a valid pair', (field, _max, set) => {
    for (const text of ['a\uD83D', '\uDE00b']) {
      expect(payloadShapeErrors(withText(set, text), 3)).toEqual([`payload.${field}: expected well-formed text`])
      expect(payloadNulErrors(withText(set, text))).toEqual([`payload.${field}: expected well-formed text`])
    }
    expect(payloadShapeErrors(withText(set, 'cof😀fee'), 3)).toEqual([])
    expect(payloadNulErrors(withText(set, 'cof😀fee'))).toEqual([])
  })

  it.each(receipt.filter(([, max]) => max))('bounds %s at %i characters in the shape check only', (field, max, set) => {
    expect(payloadShapeErrors(withText(set, 'x'.repeat(max + 1)), 3)).toEqual([`payload.${field}: expected at most ${max} characters`])
    expect(payloadNulErrors(withText(set, 'x'.repeat(max + 1)))).toEqual([])
    expect(payloadShapeErrors(withText(set, 'x'.repeat(max)), 3)).toEqual([])
  })

  it.each(receipt.filter(([, max]) => !max))('caps no length of %s: neither the till nor Medusa does', (_field, _max, set) => {
    expect(payloadShapeErrors(withText(set, 'x'.repeat(1000)), 3)).toEqual([])
    expect(payloadNulErrors(withText(set, 'x'.repeat(1000)))).toEqual([])
  })

  it.each([{ display: 'EUR', taxByRate: 'VAT' }, { display: { lines: [null, 'x', { discounts: [null, 5] }] }, taxByRate: [null, 5] }])(
    'adds nothing for a missing or non-object parent %j', value => {
      expect(() => payloadNulErrors({ ...payload, ...value })).not.toThrow()
      expect(payloadNulErrors({ ...payload, ...value })).toEqual([])
    })
})
