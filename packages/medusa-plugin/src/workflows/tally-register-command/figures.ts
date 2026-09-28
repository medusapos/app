import type { MedusaContainer } from '@medusajs/framework/types'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { TALLY_REGISTER_MODULE } from '../../modules/tally-register'
import type TallyRegisterModuleService from '../../modules/tally-register/service'

// A POS sale stays a received fact after an admin archives or cancels it, so reconciliation never changes after the fact.
const ORDER_STATUSES_COUNTED = ['completed', 'archived', 'canceled']

export function deriveSessionFigures(input: {
  countedFloatMinor: number
  orders: { payments: { method: string; amountMinor: number }[] }[]
  movements: { id: string; type: 'paid_in' | 'paid_out' | 'no_sale' | 'void'; amountMinor: number; voids: string | null }[]
}): { expected: Record<string, number>; salesCount: number } {
  const expected: Record<string, number> = Object.assign(Object.create(null), { cash: input.countedFloatMinor })
  // tally_payments is order metadata an admin could edit, and a malformed row must never make register commands transient.
  for (const order of input.orders) {
    if (!Array.isArray(order.payments)) continue
    for (const payment of order.payments) {
      if (typeof payment?.method !== 'string' || !payment.method.length || !Number.isSafeInteger(payment.amountMinor)) continue
      expected[payment.method] = (expected[payment.method] ?? 0) + payment.amountMinor
    }
  }
  const voided = new Set(input.movements.filter(row => row.type === 'void').map(row => row.voids))
  for (const row of input.movements) {
    if (row.type === 'void' || voided.has(row.id)) continue
    if (row.type === 'paid_in') expected.cash += row.amountMinor
    if (row.type === 'paid_out') expected.cash -= row.amountMinor
  }
  return { expected: { ...expected }, salesCount: input.orders.length }
}

export function deriveVariance(counted: Record<string, number>, expected: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(counted).map(([key, value]) => [key, value - (expected[key] ?? 0)]))
}

export async function loadSessionFigures(container: MedusaContainer, sessionId: string) {
  const service = container.resolve<TallyRegisterModuleService>(TALLY_REGISTER_MODULE)
  const input = await service.figuresInput(sessionId)
  if (!input) return null
  const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  const query = knex('order').select(knex.raw("metadata->'tally_payments' as payments"))
    .whereNull('deleted_at').whereIn('status', ORDER_STATUSES_COUNTED).where('is_draft_order', false)
    .whereRaw("metadata->'tally_payments' is not null").orderBy('created_at', 'asc')
  if (input.closure) {
    query.whereRaw("metadata->>'tally_client_id' = any(?)", [input.closure.orderIds])
  } else {
    query.whereRaw("metadata->>'tally_session_id' = ?", [sessionId])
  }
  const movements = input.closure
    ? input.movements.filter(row => row.type === 'void' || input.closure!.movementIds.includes(row.id))
    : input.movements
  const figures = deriveSessionFigures({ countedFloatMinor: input.countedFloatMinor, orders: await query, movements })
  return { ...figures, ...(input.closure ? { variance: deriveVariance(input.closure.counted, figures.expected) } : {}) }
}
