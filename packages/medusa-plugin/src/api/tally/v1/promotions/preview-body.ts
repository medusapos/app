import type { CouponLine, CouponSale } from '../../../../workflows/tally-coupons/coupon-context'

export type PromotionsPreviewRequest = CouponSale & { codes: string[] }

export function parsePromotionsPreviewBody(body: unknown): { ok: true; value: PromotionsPreviewRequest } | { ok: false; message: string } {
  const plain = typeof body === 'object' && body !== null &&
    (Object.getPrototypeOf(body) === Object.prototype || Object.getPrototypeOf(body) === null)
  const payload = (plain ? body : {}) as Record<string, unknown>
  const errors: string[] = []
  if (typeof payload.currency !== 'string' || payload.currency.length !== 3 || !/^[A-Za-z]{3}$/.test(payload.currency)) {
    errors.push('currency: expected 3 ASCII letters')
  }
  if ('locationId' in payload && (typeof payload.locationId !== 'string' || payload.locationId.length === 0)) {
    errors.push('locationId: expected a non-empty string')
  }
  if ('customerId' in payload && payload.customerId !== null &&
    (typeof payload.customerId !== 'string' || payload.customerId.length === 0)) {
    errors.push('customerId: expected a non-empty string or null')
  }
  const codes: string[] = []
  if (!Array.isArray(payload.codes) || payload.codes.length < 1 || payload.codes.length > 10) {
    errors.push('codes: expected an array of 1..10 entries')
  }
  if (Array.isArray(payload.codes)) payload.codes.forEach((code, index) => {
    if (typeof code !== 'string' || code.trim().length < 1 || code.trim().length > 64) {
      errors.push(`codes[${index}]: expected a string of 1..64 characters after trim`)
    } else codes.push(code.trim())
  })
  const lines: CouponLine[] = []
  const lineIds = new Set<string>()
  if (!Array.isArray(payload.lines) || payload.lines.length < 1 || payload.lines.length > 500) {
    errors.push('lines: expected an array of 1..500 entries')
  }
  if (Array.isArray(payload.lines)) payload.lines.forEach((entry, index) => {
    const prefix = `lines[${index}]`
    if (typeof entry !== 'object' || entry === null ||
      (Object.getPrototypeOf(entry) !== Object.prototype && Object.getPrototypeOf(entry) !== null)) {
      errors.push(`${prefix}: expected an object`)
      return
    }
    const line = entry as Record<string, unknown>
    if (typeof line.lineId !== 'string' || line.lineId.length < 1 || line.lineId.length > 128) {
      errors.push(`${prefix}.lineId: expected a string of 1..128 characters`)
    } else {
      if (lineIds.has(line.lineId)) errors.push(`${prefix}.lineId: expected a unique lineId`)
      lineIds.add(line.lineId)
    }
    if ('variantId' in line && line.variantId !== null &&
      (typeof line.variantId !== 'string' || line.variantId.length === 0)) {
      errors.push(`${prefix}.variantId: expected a non-empty string or null`)
    }
    if (typeof line.quantity !== 'number' || !Number.isSafeInteger(line.quantity) || line.quantity <= 0) {
      errors.push(`${prefix}.quantity: expected a positive safe integer`)
    }
    if (typeof line.taxInclusive !== 'boolean') errors.push(`${prefix}.taxInclusive: expected a boolean`)
    if (typeof line.netMinor !== 'number' || !Number.isSafeInteger(line.netMinor) || line.netMinor < 0) {
      errors.push(`${prefix}.netMinor: expected a safe integer >= 0`)
    }
    if (typeof line.taxRatePpm !== 'number' || !Number.isInteger(line.taxRatePpm) || line.taxRatePpm < 0 || line.taxRatePpm > 1000000) {
      errors.push(`${prefix}.taxRatePpm: expected an integer 0..1000000`)
    }
    lines.push({
      lineId: line.lineId as string, ...(typeof line.variantId === 'string' ? { variantId: line.variantId } : {}),
      quantity: line.quantity as number, taxInclusive: line.taxInclusive as boolean,
      netMinor: line.netMinor as number, taxRatePpm: line.taxRatePpm as number,
    })
  })
  if (errors.length) return { ok: false, message: errors.join('; ') }
  return { ok: true, value: {
    currency: payload.currency as string,
    ...(typeof payload.locationId === 'string' ? { locationId: payload.locationId } : {}),
    ...(typeof payload.customerId === 'string' ? { customerId: payload.customerId } : {}),
    codes, lines,
  } }
}
