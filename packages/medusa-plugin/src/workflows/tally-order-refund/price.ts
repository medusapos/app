import type { OrderRefundPayload } from '@tallyui/core' with { 'resolution-mode': 'import' }

/** A decimal as digits × 10^-scale, exactly: @tallyui/connector-medusa 4.1.0 decimal() (dist/index.js:991), also for raw strings. */
function decimal(value: string | number): { digits: bigint; scale: number } {
  const match = /^(-?\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(value))
  if (!match || (typeof value === 'number' && !Number.isFinite(value))) throw new RangeError(`Not a finite decimal: ${String(value)}`)
  const [, int, frac = '', exp = '0'] = match
  const scale = frac.length - Number(exp)
  const digits = BigInt(`${int}${frac}`)
  return scale >= 0 ? { digits, scale } : { digits: digits * 10n ** BigInt(-scale), scale: 0 }
}

/** connector-medusa 4.1.0 medusaSumMinor (dist/index.js:998-1006): sum exactly, round once half away from zero. */
export function medusaSumMinor(decimals: number, add: (string | number)[], subtract: (string | number)[] = []): number {
  const terms = [...add.map(value => [decimal(value), 1n] as const), ...subtract.map(value => [decimal(value), -1n] as const)]
  const scale = Math.max(decimals, ...terms.map(([term]) => term.scale))
  let total = 0n
  for (const [term, sign] of terms) total += sign * term.digits * 10n ** BigInt(scale - term.scale)
  const divisor = 10n ** BigInt(scale - decimals)
  const rounded = ((total < 0n ? -total : total) + divisor / 2n) / divisor
  const minor = Number(total < 0n ? -rounded : rounded)
  if (!Number.isSafeInteger(minor)) throw new RangeError('minor amount exceeds safe integer range')
  return minor
}

/** The connector's line split (dist/index.js:1028-1031): net = round(gross − tax), tax = round(gross) − net. */
export function connectorSplit(gross: string | number, tax: string | number, decimals: number): { netMinor: number; taxMinor: number } {
  const netMinor = medusaSumMinor(decimals, [gross], [tax])
  return { netMinor, taxMinor: medusaSumMinor(decimals, [gross]) - netMinor }
}

/** @tallyui/pos 4.1.0 roundRatio(n, d, 'half_up') (dist/index.js:319). */
function roundHalfUp(n: bigint, d: bigint): bigint {
  const a = 2n * n + d, b = 2n * d
  return a / b - (a < 0n && a % b !== 0n ? 1n : 0n)
}

/** Units r+1..r+q of a line's figure: the cumulative share, as pos priceRefund takes it (dist/index.js:13809). */
export function shareMinor(total: number, quantity: number, refunded: number, now: number): number {
  const at = (units: number) => roundHalfUp(BigInt(units) * BigInt(total), BigInt(quantity))
  return Number(at(refunded + now) - at(refunded))
}

export interface RefundableLine { id: string; quantity: number; netMinor: number; taxMinor: number }
export interface PricedLine { orderLineId: string; quantity: number; restock: boolean; netMinor: number; taxMinor: number }
export interface RefundRefusal { code: 'nothing_to_refund' | 'quantity_exceeds' | 'amount_mismatch' | 'order_state'; message: string; data?: Record<string, unknown> }

export interface PriceRefundInput {
  lines: RefundableLine[]
  linesMoneyMinor: number | null
  /** The order's shipping, gross, in minor units. */
  shippingMinor: number
  /** What earlier refunds of this order took back. */
  earlier: { lines: PricedLine[]; shippingMinor: number }[]
  /** The payment less Medusa's refunds and earlier refunds not yet sent; null when the order has no payment. */
  refundableMoneyMinor: number | null
  request: Pick<OrderRefundPayload, 'lines' | 'shippingMinor' | 'adjustmentMinor' | 'totalMinor'>
}

/** Prices an order.refund the store's way (ADR 0026 decision 5) and refuses what ADR-080 refuses. Pure. */
export function priceRefund(input: PriceRefundInput): { ok: true; lines: PricedLine[]; totalMinor: number } | { ok: false; error: RefundRefusal } {
  const { request } = input
  const nothing = { ok: false as const, error: { code: 'nothing_to_refund' as const, message: 'There is nothing to refund on this order.' } }
  if (input.refundableMoneyMinor === null || input.linesMoneyMinor === null) return nothing
  if (request.lines.length === 0 && request.shippingMinor === 0 && request.adjustmentMinor === 0) return nothing
  const refunded = new Map<string, number>()
  for (const earlier of input.earlier) for (const line of earlier.lines) {
    refunded.set(line.orderLineId, (refunded.get(line.orderLineId) ?? 0) + line.quantity)
  }
  const exceeded: { orderLineId: string; quantity: number; refundableQuantity: number }[] = []
  const priced: PricedLine[] = []
  for (const { orderLineId, quantity, restock } of request.lines) {
    const line = input.lines.find(candidate => candidate.id === orderLineId)
    const already = line ? Math.min(line.quantity, refunded.get(orderLineId) ?? 0) : 0
    const refundableQuantity = line ? line.quantity - already : 0
    if (!line || quantity > refundableQuantity) {
      exceeded.push({ orderLineId, quantity, refundableQuantity })
      continue
    }
    priced.push({ orderLineId, quantity, restock, netMinor: shareMinor(line.netMinor, line.quantity, already, quantity),
      taxMinor: shareMinor(line.taxMinor, line.quantity, already, quantity) })
  }
  if (exceeded.length) return { ok: false, error: { code: 'quantity_exceeds',
    message: 'A line asks for more than its refundable quantity, or is not on the order.', data: { lines: exceeded } } }
  let linesMinor = priced.reduce((sum, line) => sum + line.netMinor + line.taxMinor, 0)
  const shippingLeft = Math.max(0, input.shippingMinor - input.earlier.reduce((sum, earlier) => sum + earlier.shippingMinor, 0))
  const mismatch = (serverMinor: number, message: string) => ({ ok: false as const, error: { code: 'amount_mismatch' as const,
    message, data: { expectedMinor: request.totalMinor, serverMinor } } })
  // serverMinor is what the store would refund: the shipping capped at what is left of it, the total at the money left.
  if (request.shippingMinor > shippingLeft) {
    return mismatch(linesMinor + shippingLeft + request.adjustmentMinor, 'The shipping refunded is more than the order has left to refund.')
  }
  // Desk rulings A/B (2026-11-23): the last units take payment less gross shipping, fees and earlier line money only.
  // B/N1: the last covering net, else the largest net for a positive difference or covering largest gross's tax for a negative one.
  const taken = new Map(request.lines.map(line => [line.orderLineId, line.quantity]))
  if (priced.length && input.lines.every(line => (refunded.get(line.id) ?? 0) + (taken.get(line.id) ?? 0) >= line.quantity)) {
    const remainderMinor = input.linesMoneyMinor - input.earlier.reduce((sum, earlier) =>
      sum + earlier.lines.reduce((total, line) => total + line.netMinor + line.taxMinor, 0), 0)
    const difference = remainderMinor - linesMinor
    if (Math.abs(difference) > input.lines.length) {
      return { ok: false, error: { code: 'order_state',
        message: "The order's money and its lines differ by more than rounding; an admin must look at this order.", data: { state: 'money_drift' } } }
    }
    const covering = [...priced].reverse().find(line => line.netMinor >= Math.abs(difference))
    if (covering || difference >= 0) {
      const target = covering ?? priced.reduce((largest, line) => line.netMinor >= largest.netMinor ? line : largest)
      target.netMinor += difference
      linesMinor = remainderMinor
    } else {
      const target = priced.reduce((largest, line) => line.netMinor + line.taxMinor >= largest.netMinor + largest.taxMinor ? line : largest)
      if (target.taxMinor + difference >= 0) {
        target.taxMinor += difference
        linesMinor = remainderMinor
      }
    }
  }
  const totalMinor = linesMinor + request.shippingMinor + request.adjustmentMinor
  if (totalMinor !== request.totalMinor) return mismatch(totalMinor, "The refund total differs from the store's.")
  if (totalMinor === 0) return nothing
  if (totalMinor > input.refundableMoneyMinor) {
    return mismatch(input.refundableMoneyMinor, 'The refund is more than the money the order has left to refund.')
  }
  return { ok: true, lines: priced, totalMinor }
}
