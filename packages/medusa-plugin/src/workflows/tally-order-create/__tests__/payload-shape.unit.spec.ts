import type { OrderCreatePayload } from '@tallyui/core'
import { payloadShapeErrors } from '../payload-shape'

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

it.each([undefined, null, {}, { email: '' }])('accepts optional customer %j', customer => {
  expect(payloadShapeErrors({ ...payload, customer })).toEqual([])
})

it('leaves value rules to the planner and accepts absent optional fields and empty payments', () => {
  expect(payloadShapeErrors({
    ...payload, createdAt: '', currency: '', subtotalMinor: -1, taxMinor: 0.5, totalMinor: Number.MAX_VALUE,
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
  expect(payloadShapeErrors({ ...payload, [field as string]: value })).toEqual([`${field}: expected ${expected}`])
})

it.each([
  ['lines', 'clientLineId', undefined, 'a string'], ['lines', 'variantId', 1, 'a string'],
  ['lines', 'title', null, 'a string'], ['lines', 'quantity', '1', 'a finite number'],
  ['lines', 'unitPriceMinor', Infinity, 'a finite number'],
  ['payments', 'clientPaymentId', undefined, 'a string'], ['payments', 'method', undefined, 'a string'],
  ['payments', 'amountMinor', '1000', 'a finite number'], ['payments', 'tenderedMinor', NaN, 'a finite number'],
  ['payments', 'changeMinor', null, 'a finite number'], ['payments', 'reference', 1, 'a string'],
])('rejects invalid %s[0].%s', (field: string, key: string, value, expected: string) => {
  const item = { ...payload[field][0], [key]: value }
  expect(payloadShapeErrors({ ...payload, [field]: [item] })).toEqual([`${field}[0].${key}: expected ${expected}`])
})

it.each(['lines', 'payments'])('rejects non-object entries in %s', field => {
  for (const item of [null, [], 'item']) {
    expect(payloadShapeErrors({ ...payload, [field]: [item] })).toEqual([`${field}[0]: expected an object`])
  }
})

it('rejects a non-string customer email', () => {
  expect(payloadShapeErrors({ ...payload, customer: { email: 1 } })).toEqual(['customer.email: expected a string'])
})

it('reports at most ten errors', () => {
  const errors = payloadShapeErrors({ lines: [{}, {}, {}], payments: [{}] })
  expect(errors).toHaveLength(10)
  expect(errors.every(error => /^.+: expected /u.test(error))).toBe(true)
})
