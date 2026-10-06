import type { CommandEnvelope, OrderCreateLine, OrderCreatePayment } from '@tallyui/core' with { 'resolution-mode': 'import' }
import type { OrderCreatePayloadV3 } from './fiscal-figures'
import type { OrderCreateFee, OrderCreateShipping, OrderCreateCustomLine } from './v5'

// The fields of each order.create version (ruling 17): @tallyui/core 2.0.0 OrderCreatePayload, OrderCreateLine and
// OrderCreatePayment (src/types/commands.ts, v2) and OrderCreatePayloadV3 (@tallyui/core's OrderCreatePayload, aliased in
// fiscal-figures.ts). Each value is
// the version that added the field; Record<keyof T, number> makes tsc refuse a missing or an extra field.
const since = <T>(fields: Record<keyof T, number>) => new Map<string, number>(Object.entries(fields))
const TOP_FIELDS = since<OrderCreatePayloadV3 & { fees?: OrderCreateFee[]; shipping?: OrderCreateShipping[] }>({ clientOrderId: 1, createdAt: 1, currency: 1, pricesIncludeTax: 1, lines: 1,
  subtotalMinor: 1, taxMinor: 1, totalMinor: 1, payments: 1, customer: 1, registerId: 1, cashierRef: 1, locationId: 1,
  discountMinor: 2, display: 3, taxByRate: 3, sessionId: 3, fees: 5, shipping: 5 })
const LINE_FIELDS = since<OrderCreateLine & { custom?: OrderCreateCustomLine }>({ clientLineId: 1, variantId: 1, title: 1, quantity: 1, unitPriceMinor: 1,
  taxInclusive: 1, discountMinor: 2, custom: 5 })
const FEE_FIELDS = since<OrderCreateFee>({ clientFeeId: 5, name: 5, amountMinor: 5, taxStatus: 5, taxClass: 5, taxMinor: 5 })
const SHIPPING_FIELDS = since<OrderCreateShipping>({ clientShippingId: 5, name: 5, amountMinor: 5, taxStatus: 5, taxClass: 5, taxMinor: 5, methodId: 5 })
const CUSTOM_FIELDS = since<OrderCreateCustomLine>({ name: 5, sku: 5, taxClass: 5, taxStatus: 5 })
const PAYMENT_FIELDS = since<OrderCreatePayment>({ clientPaymentId: 1, method: 1, amountMinor: 1, tenderedMinor: 1,
  changeMinor: 1, reference: 1 })
const CUSTOMER_FIELDS = since<NonNullable<OrderCreatePayloadV3['customer']>>({ email: 1, customerId: 3 })
// The envelope's own fields, for every command type; satisfies makes tsc refuse a missing or an extra field.
const ENVELOPE_FIELDS = Object.keys({ id: true, type: true, version: true, payload: true, createdAt: true, deviceId: true,
  attempt: true } satisfies Record<keyof CommandEnvelope, true>)
/** Envelope fields CommandEnvelope doesn't declare, e.g. ['envelope.priority: unknown field for order.create version 1']. */
export const envelopeErrors = (envelope: CommandEnvelope<unknown>) => Object.keys(envelope).filter(key => !ENVELOPE_FIELDS.includes(key))
  .map(key => `envelope.${key}: unknown field for ${envelope.type} version ${envelope.version}`)

/** Shape errors of an order.create payload, e.g. ['payload.lines: expected a non-empty array',
 * 'payload.payments[0].method: expected a string']; [] when the shape is valid. Checks presence, types, fields unknown to
 * `version`, string bounds and NUL (numbers are finite numbers; value ranges are the planner's job). `version`
 * defaults to the latest; a field a later version declares is named with that version ('payload.display: requires version 3'). */
export function payloadShapeErrors(payload: unknown, version = 3): string[] {
  const errors: string[] = []
  const object = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
  const check = (valid: boolean, path: string, expected: string) => {
    if (!valid && errors.length < 10) errors.push(`payload.${path}: expected ${expected}`)
  }
  const known = (value: Record<string, unknown>, fields: Map<string, number>, prefix: string) => {
    for (const key of Object.keys(value)) {
      const added = fields.get(key) ?? Infinity
      if (added > version && errors.length < 10) errors.push(`payload.${prefix}${key}: ${added === Infinity
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
      if (isLines && item.custom !== undefined) check(!('variantId' in item), `${path}.variantId`, 'no variantId on a custom line')
      for (const key of isLines ? ['clientLineId', ...(item.custom === undefined ? ['variantId'] : [])] : ['clientPaymentId', 'method']) {
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
  for (const field of ['fees', 'shipping', 'lines']) {
    const items = payload[field], custom = field === 'lines', id = field === 'fees' ? 'clientFeeId' : 'clientShippingId'
    if (!custom && items !== undefined) check(Array.isArray(items), field, 'an array')
    if (!Array.isArray(items)) continue
    const firstIds = new Map<string, number>()
    for (const [index, item] of items.entries()) {
      if (custom && item?.custom === undefined) continue
      const value = custom ? item.custom : item, path = `${field}[${index}]${custom ? '.custom' : ''}`
      check(object(value), path, 'an object')
      if (!object(value)) continue
      known(value, custom ? CUSTOM_FIELDS : field === 'fees' ? FEE_FIELDS : SHIPPING_FIELDS, `${path}.`)
      for (const key of ['name', 'taxClass', ...(custom ? ['sku'] : [id, ...(field === 'shipping' ? ['methodId'] : [])])]) {
        const required = key === 'name' || key === id
        if (required || value[key] !== undefined) check(typeof value[key] === 'string' && (!required || (value[key] as string).length > 0),
          `${path}.${key}`, required ? 'a non-empty string' : 'a string')
      }
      check(value.taxStatus === 'taxable' || value.taxStatus === 'none', `${path}.taxStatus`, "'taxable' or 'none'")
      if (custom) continue
      for (const key of ['amountMinor', 'taxMinor']) check(Number.isSafeInteger(value[key]) && (value[key] as number) >= 0, `${path}.${key}`, 'a non-negative safe integer')
      if (typeof value[id] !== 'string') continue
      const first = firstIds.get(value[id] as string)
      if (first !== undefined && first >= 0) check(false, `${path}.${id}`, `no duplicate of payload.${field}[${first}].${id}`)
      firstIds.set(value[id] as string, first === undefined ? index : -1)
    }
  }
  // One error per repeated clientLineId, at its second occurrence; -1 marks an id already reported.
  const firstLine = new Map<string, number>()
  for (const [index, line] of (Array.isArray(payload.lines) ? payload.lines : []).entries()) {
    if (!object(line) || typeof line.clientLineId !== 'string') continue
    const first = firstLine.get(line.clientLineId)
    if (first !== undefined && first >= 0) check(false, `lines[${index}].clientLineId`, `no duplicate of payload.lines[${first}].clientLineId`)
    firstLine.set(line.clientLineId, first === undefined ? index : -1)
  }
  for (const field of ['subtotalMinor', 'taxMinor', 'totalMinor']) number(payload[field], field)
  const lineDiscounts = (Array.isArray(payload.lines) ? payload.lines : [])
    .reduce((sum: bigint, line, index) => sum + (object(line) ? discount(line.discountMinor, `lines[${index}].discountMinor`) : 0n), 0n)
  const orderDiscount = discount(payload.discountMinor, 'discountMinor')
  if (errors.length === 0) check(orderDiscount === lineDiscounts, 'discountMinor', 'the sum of payload.lines[].discountMinor')
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
  for (const field of ['fees', 'shipping', 'lines']) {
    if (!Array.isArray(value[field])) continue
    for (const [index, item] of (value[field] as unknown[]).entries()) {
      const entry = item as Record<string, unknown> | null, custom = field === 'lines'
      const strings = (custom ? entry?.custom : entry) as Record<string, unknown> | null | undefined
      fields.push([`${field}[${index}]${custom ? '.custom' : ''}.taxStatus`, strings?.taxStatus, 0])
      for (const key of custom ? ['name', 'sku', 'taxClass'] : ['name', 'taxClass', field === 'fees' ? 'clientFeeId' : 'clientShippingId', ...(field === 'shipping' ? ['methodId'] : [])])
        fields.push([`${field}[${index}]${custom ? '.custom' : ''}.${key}`, strings?.[key], key === 'name' ? 255 : 64])
    }
  }
  for (const [path, text, max] of fields) {
    if (typeof text !== 'string') continue
    if (bounds && max && text.length > max) errors.push(`payload.${path}: expected at most ${max} characters`)
    if (text.includes('\0')) errors.push(`payload.${path}: expected no NUL character`)
  }
  return errors.slice(0, 10)
}
