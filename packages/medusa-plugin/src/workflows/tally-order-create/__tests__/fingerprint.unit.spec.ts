import { createHash } from 'node:crypto'
import { canonicalJson, commandFingerprint } from '../fingerprint'

const envelope = { type: 'order.create' as const, version: 1 as const, payload: { b: 2, a: 1 } }

it('does not change the fingerprint when object keys are reordered', () => {
  expect(commandFingerprint(envelope)).toBe(commandFingerprint({
    payload: { a: 1, b: 2 }, version: 1, type: 'order.create',
  }))
})

it('preserves array order in the fingerprint', () => {
  expect(commandFingerprint({ ...envelope, payload: [1, 2] }))
    .not.toBe(commandFingerprint({ ...envelope, payload: [2, 1] }))
  expect(canonicalJson([2, 1])).toBe('[2,1]')
})

it('sorts nested objects including objects in arrays', () => {
  const payload = { z: [{ y: 2, x: { b: true, a: null } }], a: { z: 'end', a: 'start' } }
  expect(canonicalJson(payload)).toBe('{"a":{"a":"start","z":"end"},"z":[{"x":{"a":null,"b":true},"y":2}]}')
  expect(commandFingerprint({ ...envelope, payload })).toBe(commandFingerprint({
    ...envelope, payload: { a: { a: 'start', z: 'end' }, z: [{ x: { a: null, b: true }, y: 2 }] },
  }))
})

it('omits undefined object members as JSON.stringify does', () => {
  expect(canonicalJson({ b: undefined, a: { c: undefined, d: 1 } })).toBe('{"a":{"d":1}}')
  expect(commandFingerprint({ ...envelope, payload: { ...envelope.payload, c: undefined } }))
    .toBe(commandFingerprint(envelope))
})

it('fingerprints lines without taxInclusive exactly as with it undefined, and differently from false', () => {
  const line = { clientLineId: 'line_1', variantId: 'variant_1', quantity: 1, unitPriceMinor: 1000 }
  const order = (lines: object[]) => ({ ...envelope, payload: { clientOrderId: 'order_1', pricesIncludeTax: true, lines } })
  expect(canonicalJson(order([line]).payload)).toBe(
    '{"clientOrderId":"order_1","lines":[{"clientLineId":"line_1","quantity":1,"unitPriceMinor":1000,"variantId":"variant_1"}],"pricesIncludeTax":true}')
  expect(commandFingerprint(order([{ ...line, taxInclusive: undefined }]))).toBe(commandFingerprint(order([line])))
  expect(commandFingerprint(order([{ ...line, taxInclusive: false }]))).not.toBe(commandFingerprint(order([line])))
})

it('hashes the literal canonical envelope using SHA-256', () => {
  const expected = '{"payload":{"a":1,"b":2},"type":"order.create","version":1}'
  expect(canonicalJson(envelope)).toBe(expected)
  expect(commandFingerprint(envelope)).toBe(createHash('sha256').update(expected).digest('hex'))
})
