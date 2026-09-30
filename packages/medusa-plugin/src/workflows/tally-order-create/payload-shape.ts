import type { CommandEnvelope, OrderCreateLine, OrderCreatePayment } from '@tallyui/core' with { 'resolution-mode': 'import' }
import { clientTimeErrors } from '../client-time'
import type { OrderCreatePayloadV3 } from './fiscal-figures'

// The fields of each order.create version (ruling 17): @tallyui/core 2.0.0 OrderCreatePayload, OrderCreateLine and
// OrderCreatePayment (src/types/commands.ts, v2) and the v3 bridge OrderCreatePayloadV3 (fiscal-figures.ts). Each value is
// the version that added the field; Record<keyof T, number> makes tsc refuse a missing or an extra field.
const since = <T>(fields: Record<keyof T, number>) => new Map<string, number>(Object.entries(fields))
const TOP_FIELDS = since<OrderCreatePayloadV3>({ clientOrderId: 1, createdAt: 1, currency: 1, pricesIncludeTax: 1, lines: 1,
  subtotalMinor: 1, taxMinor: 1, totalMinor: 1, payments: 1, customer: 1, registerId: 1, cashierRef: 1, locationId: 1,
  discountMinor: 2, display: 3, taxByRate: 3, sessionId: 3 })
const LINE_FIELDS = since<OrderCreateLine>({ clientLineId: 1, variantId: 1, title: 1, quantity: 1, unitPriceMinor: 1,
  taxInclusive: 1, discountMinor: 2 })
const PAYMENT_FIELDS = since<OrderCreatePayment>({ clientPaymentId: 1, method: 1, amountMinor: 1, tenderedMinor: 1,
  changeMinor: 1, reference: 1 })
const CUSTOMER_FIELDS = since<NonNullable<OrderCreatePayloadV3['customer']>>({ email: 1, customerId: 3 })
// The envelope's own fields, for every command type; satisfies makes tsc refuse a missing or an extra field.
const ENVELOPE_FIELDS = Object.keys({ id: true, type: true, version: true, payload: true, createdAt: true, deviceId: true,
  attempt: true } satisfies Record<keyof CommandEnvelope, true>)
/** Envelope fields CommandEnvelope doesn't declare, e.g. ['envelope.priority: unknown field for order.create version 1'],
 * then an out-of-bounds envelope.createdAt (client time). */
export const envelopeErrors = (envelope: CommandEnvelope<unknown>) => [...Object.keys(envelope).filter(key => !ENVELOPE_FIELDS.includes(key))
  .map(key => `envelope.${key}: unknown field for ${envelope.type} version ${envelope.version}`),
...clientTimeErrors(envelope.createdAt, 'envelope.createdAt')]

/** Shape errors of an order.create payload, e.g. ['lines: expected a non-empty array',
 * 'payments[0].method: expected a string']; [] when the shape is valid. Checks presence, types, fields unknown to
 * `version`, string bounds and NUL (numbers are finite numbers; value ranges are the planner's job). `version`
 * defaults to the latest; a field a later version declares is named with that version ('display: requires version 3'). */
export function payloadShapeErrors(payload: unknown, version = 3): string[] {
  const errors: string[] = []
  const object = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
  const check = (valid: boolean, path: string, expected: string) => {
    if (!valid && errors.length < 10) errors.push(`${path}: expected ${expected}`)
  }
  const known = (value: Record<string, unknown>, fields: Map<string, number>, prefix: string) => {
    for (const key of Object.keys(value)) {
      const added = fields.get(key) ?? Infinity
      if (added > version && errors.length < 10) errors.push(`${prefix}${key}: ${added === Infinity
        ? `unknown field for order.create version ${version}` : `requires version ${added}`}`)
    }
  }
  const number = (value: unknown, path: string) =>
    check(typeof value === 'number' && Number.isFinite(value), path, 'a finite number')
  // Discounts (ADR-062) are checked here, values included, when present.
  const discount = (value: unknown, path: string): bigint => {
    const valid = value === undefined || (Number.isSafeInteger(value) && (value as number) > 0)
    check(valid, path, 'a positive safe integer')
    return valid && value !== undefined ? BigInt(value as number) : 0n
  }
  if (!object(payload)) return ['payload: expected an object']
  known(payload, TOP_FIELDS, '')
  check(typeof payload.clientOrderId === 'string' && payload.clientOrderId.length > 0, 'clientOrderId', 'a non-empty string')
  for (const field of ['createdAt', 'currency']) check(typeof payload[field] === 'string', field, 'a string')
  errors.push(...clientTimeErrors(payload.createdAt, 'createdAt'))
  check(typeof payload.pricesIncludeTax === 'boolean', 'pricesIncludeTax', 'a boolean')
  for (const field of ['lines', 'payments']) {
    const items = payload[field]
    const isLines = field === 'lines'
    check(Array.isArray(items) && (!isLines || items.length > 0), field, isLines ? 'a non-empty array' : 'an array')
    if (!Array.isArray(items)) continue
    for (const [index, item] of items.entries()) {
      if (errors.length === 10) break
      const path = `${field}[${index}]`
      check(object(item), path, 'an object')
      if (!object(item)) continue
      known(item, isLines ? LINE_FIELDS : PAYMENT_FIELDS, `${path}.`)
      for (const key of isLines ? ['clientLineId', 'variantId'] : ['clientPaymentId', 'method']) {
        check(typeof item[key] === 'string', `${path}.${key}`, 'a string')
      }
      const optionalString = isLines ? 'title' : 'reference'
      if (item[optionalString] !== undefined) {
        check(typeof item[optionalString] === 'string', `${path}.${optionalString}`, 'a string')
      }
      if (isLines && item.taxInclusive !== undefined) {
        check(typeof item.taxInclusive === 'boolean', `${path}.taxInclusive`, 'a boolean')
      }
      for (const key of isLines ? ['quantity', 'unitPriceMinor'] : ['amountMinor']) number(item[key], `${path}.${key}`)
      if (!isLines) {
        for (const key of ['tenderedMinor', 'changeMinor']) {
          if (item[key] !== undefined) number(item[key], `${path}.${key}`)
        }
      }
    }
  }
  // One error per repeated clientLineId, at its second occurrence; -1 marks an id already reported.
  const firstLine = new Map<string, number>()
  for (const [index, line] of (Array.isArray(payload.lines) ? payload.lines : []).entries()) {
    if (!object(line) || typeof line.clientLineId !== 'string') continue
    const first = firstLine.get(line.clientLineId)
    if (first !== undefined && first >= 0) check(false, `lines[${index}].clientLineId`, `no duplicate of lines[${first}].clientLineId`)
    firstLine.set(line.clientLineId, first === undefined ? index : -1)
  }
  for (const field of ['subtotalMinor', 'taxMinor', 'totalMinor']) number(payload[field], field)
  const lineDiscounts = (Array.isArray(payload.lines) ? payload.lines : [])
    .reduce((sum: bigint, line, index) => sum + (object(line) ? discount(line.discountMinor, `lines[${index}].discountMinor`) : 0n), 0n)
  const orderDiscount = discount(payload.discountMinor, 'discountMinor')
  if (errors.length === 0) check(orderDiscount === lineDiscounts, 'discountMinor', 'the sum of lines[].discountMinor')
  if (payload.customer !== undefined && payload.customer !== null) {
    check(object(payload.customer), 'customer', 'an object')
    if (object(payload.customer)) known(payload.customer, CUSTOMER_FIELDS, 'customer.')
    if (object(payload.customer) && payload.customer.email !== undefined) {
      check(typeof payload.customer.email === 'string', 'customer.email', 'a string')
    }
    if (object(payload.customer) && payload.customer.customerId !== undefined) {
      const id = payload.customer.customerId
      check(typeof id === 'string' && id.length > 0 && id.length <= 64, 'customer.customerId', 'a string of at most 64 characters')
    }
  }
  if (payload.sessionId !== undefined) {
    check(typeof payload.sessionId === 'string' && payload.sessionId.length > 0 && payload.sessionId.length <= 36,
      'sessionId', 'a string of at most 36 characters')
  }
  for (const field of ['registerId', 'cashierRef', 'locationId']) {
    if (payload[field] !== undefined) check(typeof payload[field] === 'string', field, 'a string')
  }
  return [...errors, ...payloadStringErrors(payload, true)].slice(0, 10)
}

export function payloadNulErrors(payload: unknown): string[] {
  return payloadStringErrors(payload, false)
}

function payloadStringErrors(payload: unknown, bounds: boolean): string[] {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return []
  const value = payload as Record<string, unknown>
  const fields: [string, unknown, number][] = ['clientOrderId', 'createdAt', 'currency', 'registerId', 'cashierRef', 'locationId']
    .map(key => [key, value[key], 255])
  const customer = value.customer as Record<string, unknown> | null | undefined
  fields.push(['customer.email', customer?.email, 254], ['customer.customerId', customer?.customerId, 0], ['sessionId', value.sessionId, 0])
  for (const field of ['lines', 'payments']) {
    const items = value[field]
    if (!Array.isArray(items)) continue
    for (const [index, item] of items.entries()) {
      for (const key of field === 'lines' ? ['clientLineId', 'variantId', 'title'] : ['clientPaymentId', 'method', 'reference']) {
        fields.push([`${field}[${index}].${key}`, item?.[key], 255])
      }
    }
  }
  const errors: string[] = []
  for (const [path, text, max] of fields) {
    if (typeof text !== 'string') continue
    if (bounds && max && text.length > max) errors.push(`${path}: expected at most ${max} characters`)
    if (text.includes('\0')) errors.push(`${path}: expected no NUL character`)
  }
  return errors.slice(0, 10)
}
