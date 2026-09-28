/** Shape errors before a register command claims a ledger row. Unknown top-level keys are allowed. */
export function registerPayloadErrors(type: string, payload: unknown): string[] {
  const errors: string[] = []
  const object = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  const check = (valid: boolean, field: string, expected: string) => {
    if (!valid && errors.length < 10) errors.push(`${field}: expected ${expected}`)
  }
  if (!object(payload)) return ['payload: expected an object']
  const string = (field: string, optional = false) => {
    const value = payload[field]
    if (optional && value === undefined) return
    check(typeof value === 'string' && (optional || value.length > 0), field, optional ? 'a string' : 'a non-empty string')
    if (typeof value === 'string' && (field.endsWith('Id') || field === 'voids')) check(value.length <= 64, field, 'at most 64 characters')
    if (typeof value === 'string' && ['openedAt', 'at', 'createdAt', 'closedAt'].includes(field)) {
      check(!Number.isNaN(Date.parse(value)), field, 'a valid date')
    }
  }
  const integer = (field: string, min = -Infinity) =>
    check(Number.isSafeInteger(payload[field]) && (payload[field] as number) >= min, field, `a safe integer >= ${min}`)
  const record = (field: string) => {
    const value = payload[field]
    check(object(value), field, 'a record of integers')
    if (object(value)) for (const [key, amount] of Object.entries(value)) {
      check(key.length > 0 && Number.isSafeInteger(amount), `${field}.${key}`, 'a non-empty key with a safe integer')
    }
  }
  string('sessionId')
  switch (type) {
    case 'register.session.open':
      for (const field of ['registerId', 'openedAt']) string(field)
      for (const field of ['storeKey', 'businessDay', 'openedBy']) string(field, true)
      integer('countedFloatMinor', 0)
      for (const field of ['expectedFloatMinor', 'openingVarianceMinor']) if (payload[field] !== undefined) integer(field)
      break
    case 'register.session.transition':
      string('at')
      check(['open', 'counting', 'closed'].includes(payload.status as string), 'status', 'open, counting or closed')
      for (const field of ['counted', 'closedBy', 'approvedBy']) if (payload[field] !== undefined) {
        check(payload.status === 'closed', field, 'a closing transition')
        if (field === 'counted') record(field)
        else string(field, true)
      }
      break
    case 'register.movement.record':
    case 'register.movement.void':
      for (const field of ['movementId', 'createdAt']) string(field)
      string('createdBy', true)
      if (type === 'register.movement.void') string('voids')
      else {
        check(typeof payload.reason === 'string' && payload.reason.trim().length > 0 && payload.reason.length <= 500,
          'reason', 'a non-empty string after trim of at most 500 characters')
        check(['paid_in', 'paid_out', 'no_sale'].includes(payload.type as string), 'type', 'paid_in, paid_out or no_sale')
        integer('amountMinor', payload.type === 'no_sale' ? 0 : 1)
        if (payload.type === 'no_sale') check(payload.amountMinor === 0, 'amountMinor', '0 for no_sale')
      }
      break
    case 'register.closure.submit':
      for (const field of ['closureId', 'registerId', 'openedAt', 'closedAt', 'softwareVersion']) string(field)
      for (const field of ['businessDay', 'closedBy', 'approvedBy']) string(field, true)
      integer('number', 1)
      for (const field of ['periodSalesTotalMinor', 'periodRefundsTotalMinor', 'perpetualSalesTotalMinor',
        'perpetualRefundsTotalMinor', 'unsyncedCount', 'unsyncedTotalMinor']) integer(field, 0)
      for (const field of ['number', 'unsyncedCount'])
        check((payload[field] as number) <= 2147483647, field, 'at most 2147483647')
      for (const field of ['tillExpected', 'counted']) record(field)
      for (const field of ['orderIds', 'movementIds']) {
        const value = payload[field]
        check(Array.isArray(value), field, 'an array of ids')
        if (Array.isArray(value)) value.forEach((id, index) =>
          check(typeof id === 'string' && id.length > 0 && id.length <= 64, `${field}[${index}]`, 'a non-empty string of at most 64 characters'))
      }
      break
    default:
      check(false, 'type', 'a register command type')
  }
  return errors
}
