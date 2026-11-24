/** A till tender as order.create stores it in order.metadata.tally_payments (tally-order-create/plan.ts). */
export interface TillTender { id?: unknown; method: string; amountMinor: number; tenderedMinor?: number; changeMinor?: number }
export interface SplitEntry { paymentId: string; method: string; totalMinor: number }

/**
 * Splits a refund over the sale's tenders (ADR 0026 decision 4). A tender can give back its amountMinor less what
 * earlier refunds gave back to it, never its tenderedMinor, so change is never refundable. `cash` puts it all on
 * cash; `original_method` takes non-cash tenders first in the order taken, then cash tenders, then a plain cash entry.
 */
export function splitRefund(input: { orderId: string; tenders: TillTender[]; earlier: SplitEntry[]; totalMinor: number;
  destination: 'original_method' | 'cash' }): { refunds: SplitEntry[]; byMethod: Record<string, number> } {
  const tenders = input.tenders.map((tender, index) => {
    const paymentId = typeof tender.id === 'string' && tender.id.length ? tender.id : `${input.orderId}:${index}`
    const given = input.earlier.filter(entry => entry.paymentId === paymentId).reduce((sum, entry) => sum + entry.totalMinor, 0)
    return { paymentId, method: tender.method, left: Math.max(0, tender.amountMinor - given) }
  })
  const cash = tenders.filter(tender => tender.method === 'cash')
  const order = input.destination === 'cash' ? cash : [...tenders.filter(tender => tender.method !== 'cash'), ...cash]
  const refunds: SplitEntry[] = []
  let rest = input.totalMinor
  for (const tender of order) {
    // A cash destination is not capped by what the cash tenders took: the till hands cash back for card money too.
    const take = input.destination === 'cash' ? rest : Math.min(rest, tender.left)
    if (take > 0) refunds.push({ paymentId: tender.paymentId, method: tender.method, totalMinor: take })
    rest -= take
  }
  if (rest > 0) refunds.push({ paymentId: `${input.orderId}:cash`, method: 'cash', totalMinor: rest })
  const byMethod: Record<string, number> = Object.create(null)
  for (const entry of refunds) byMethod[entry.method] = (byMethod[entry.method] ?? 0) + entry.totalMinor
  return { refunds, byMethod: { ...byMethod } }
}
