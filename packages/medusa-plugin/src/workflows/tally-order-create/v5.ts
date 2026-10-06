export type OrderCreateFee = {
  clientFeeId: string; name: string; amountMinor: number; taxStatus: 'taxable' | 'none'; taxClass?: string; taxMinor: number
}
export type OrderCreateShipping = Omit<OrderCreateFee, 'clientFeeId'> & { clientShippingId: string; methodId?: string }
export type OrderCreateCustomLine = { name: string; sku?: string; taxClass?: string; taxStatus: 'taxable' | 'none' }

export function lineTaxRefusals(payload: Record<string, unknown>): Array<{ path: string; reason: 'tax_status_unsupported' | 'tax_class_unknown'; message: string }> {
  const refusals: ReturnType<typeof lineTaxRefusals> = []
  for (const field of ['fees', 'shipping', 'lines']) {
    const items = payload[field]
    if (!Array.isArray(items)) continue
    items.forEach((item, index) => {
      const value = field === 'lines' ? item.custom : item
      if (!value) return
      const prefix = `${field}[${index}]${field === 'lines' ? '.custom' : ''}`
      if (value.taxStatus === 'none') {
        const path = `${prefix}.taxStatus`, reason = 'tax_status_unsupported'
        refusals.push({ path, reason, message: `payload.${path}: ${reason}: this store can't keep a line tax-free (ADR 0021)` })
      }
      if (value.taxClass !== undefined) {
        const path = `${prefix}.taxClass`, reason = 'tax_class_unknown'
        refusals.push({ path, reason, message: `payload.${path}: ${reason}: this store has no tax classes (ADR 0021)` })
      }
    })
  }
  return refusals
}

export function v5DisplayErrors(payload: Record<string, unknown>): string[] {
  const errors: string[] = [], display = payload.display as Record<string, unknown> | undefined
  if (!display) return errors
  const check = (valid: boolean, path: string, expected: string) => {
    if (!valid) errors.push(`payload.${path}: expected ${expected}`)
  }
  for (const field of ['fees', 'shipping']) {
    const items = display[field], id = field === 'fees' ? 'clientFeeId' : 'clientShippingId'
    if (items === undefined) continue
    check(payload[field] !== undefined, `display.${field}`, `payload.${field} to be present`)
    check(Array.isArray(items), `display.${field}`, 'an array')
    if (!Array.isArray(items)) continue
    const sources = payload[field], ids = new Set(Array.isArray(sources) ? sources.map(item => item[id]) : []), seen = new Set<string>()
    items.forEach((item, index) => {
      const path = `display.${field}[${index}]`, object = typeof item === 'object' && item !== null && !Array.isArray(item)
      check(object, path, 'an object')
      if (!object) return
      for (const key of Object.keys(item)) check(key === id || key === 'amountMinor', `${path}.${key}`, 'no unknown key')
      check(typeof item[id] === 'string' && ids.has(item[id]), `${path}.${id}`, `a payload.${field}[].${id}`)
      check(!seen.has(item[id]), `${path}.${id}`, `no duplicate ${id}`)
      seen.add(item[id])
      check(Number.isSafeInteger(item.amountMinor) && item.amountMinor >= 0, `${path}.amountMinor`, 'a non-negative safe integer')
    })
  }
  return errors
}

export function withoutV5Display<T extends { display?: object }>(payload: T): T {
  if (payload.display === undefined) return { ...payload }
  const { fees, shipping, ...display } = payload.display as Record<string, unknown>
  return { ...payload, display }
}
