/** Shape errors of an order.create payload, e.g. ['lines: expected a non-empty array',
 * 'payments[0].method: expected a string']; [] when the shape is valid. Checks types and
 * presence only (numbers are finite numbers; value ranges are the planner's job). */
export function payloadShapeErrors(payload: unknown): string[] {
  const errors: string[] = []
  const object = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
  const check = (valid: boolean, path: string, expected: string) => {
    if (!valid && errors.length < 10) errors.push(`${path}: expected ${expected}`)
  }
  const number = (value: unknown, path: string) =>
    check(typeof value === 'number' && Number.isFinite(value), path, 'a finite number')
  if (!object(payload)) return ['payload: expected an object']
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
  for (const field of ['subtotalMinor', 'taxMinor', 'totalMinor']) number(payload[field], field)
  if (payload.customer !== undefined && payload.customer !== null) {
    check(object(payload.customer), 'customer', 'an object')
    if (object(payload.customer) && payload.customer.email !== undefined) {
      check(typeof payload.customer.email === 'string', 'customer.email', 'a string')
    }
  }
  for (const field of ['registerId', 'cashierRef', 'locationId']) {
    if (payload[field] !== undefined) check(typeof payload[field] === 'string', field, 'a string')
  }
  return errors
}
