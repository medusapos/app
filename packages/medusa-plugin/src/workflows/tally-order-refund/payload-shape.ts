// A port of @tallyui/core 4.1.0 refundPayloadErrors (dist/server/index.js:782, ADR-080): core is imported as types
// only (see tally-order-create/payload-shape.ts), so the shared shape check is copied here with core's exact messages.
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)

const FIELDS = ['clientRefundId', 'orderId', 'registerId', 'sessionId', 'clientOrderId', 'cashierRef', 'lines', 'shippingMinor',
  'totalMinor', 'adjustmentMinor', 'destination', 'reason', 'createdAt']

/** order.refund v1 shape errors, at most 10, before the claim. */
export function refundPayloadErrors(payload: unknown): string[] {
  const errors: string[] = []
  const check = (valid: boolean, field: string, expected: string) => {
    if (!valid && errors.length < 10) errors.push(`${field}: expected ${expected}`)
  }
  const noNul = (value: unknown, field: string) => {
    if (typeof value === 'string') check(!value.includes('\0'), field, 'no NUL character')
  }
  if (!isPlainObject(payload)) return ['payload: expected an object']
  for (const key of Object.keys(payload)) {
    if (!FIELDS.includes(key) && errors.length < 10) {
      errors.push(`${key.includes('\0') ? JSON.stringify(key) : key}: unknown field for order.refund version 1`)
    }
  }
  for (const field of ['clientRefundId', 'orderId', 'registerId', 'sessionId', 'clientOrderId', 'cashierRef']) {
    const value = payload[field]
    if (['clientOrderId', 'cashierRef'].includes(field) && value === undefined) continue
    check(typeof value === 'string' && value.length > 0 && value.length <= 64, field, 'a non-empty string of at most 64 characters')
    noNul(value, field)
  }
  check(Array.isArray(payload.lines) && payload.lines.length <= 500, 'lines', 'an array of at most 500 lines')
  const seen = new Set<string>()
  if (Array.isArray(payload.lines)) payload.lines.forEach((line: unknown, index) => {
    const path = `lines[${index}]`
    if (!isPlainObject(line)) {
      check(false, path, 'an object')
      return
    }
    for (const key of Object.keys(line)) {
      if (!['orderLineId', 'quantity', 'restock'].includes(key) && errors.length < 10) {
        errors.push(`${path}.${key.includes('\0') ? JSON.stringify(key) : key}: unknown field for order.refund version 1`)
      }
    }
    check(typeof line.orderLineId === 'string' && line.orderLineId.length > 0 && line.orderLineId.length <= 64,
      `${path}.orderLineId`, 'a non-empty string of at most 64 characters')
    noNul(line.orderLineId, `${path}.orderLineId`)
    if (typeof line.orderLineId === 'string') {
      check(!seen.has(line.orderLineId), `${path}.orderLineId`, 'unique in lines')
      seen.add(line.orderLineId)
    }
    check(Number.isSafeInteger(line.quantity) && (line.quantity as number) >= 1, `${path}.quantity`, 'a safe integer >= 1')
    check(typeof line.restock === 'boolean', `${path}.restock`, 'a boolean')
  })
  for (const field of ['shippingMinor', 'totalMinor']) {
    check(Number.isSafeInteger(payload[field]) && (payload[field] as number) >= 0, field, 'a safe integer >= 0')
  }
  check(Number.isSafeInteger(payload.adjustmentMinor), 'adjustmentMinor', 'a safe integer')
  check(payload.destination === 'original_method' || payload.destination === 'cash', 'destination', 'original_method or cash')
  noNul(payload.destination, 'destination')
  check(typeof payload.reason === 'string' && payload.reason.trim().length > 0 && payload.reason.length <= 500,
    'reason', 'a non-empty string after trim of at most 500 characters')
  noNul(payload.reason, 'reason')
  check(typeof payload.createdAt === 'string' && payload.createdAt.length > 0 && !Number.isNaN(Date.parse(payload.createdAt)),
    'createdAt', 'a valid date')
  noNul(payload.createdAt, 'createdAt')
  return errors
}
