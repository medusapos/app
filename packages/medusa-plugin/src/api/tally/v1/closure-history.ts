import type { StoredClosure } from '../../../modules/tally-register/types'

// Default number of closures returned per page.
export const CLOSURES_DEFAULT_LIMIT = 50
// Rows carry orderIds, so cap the page to bound the response size.
export const CLOSURES_MAX_LIMIT = 100

export type ClosuresQuery = { limit: number; before?: number; from?: string; to?: string }

export function parseClosuresQuery(query: Record<string, unknown>): { ok: true; query: ClosuresQuery } | { ok: false; message: string } {
  const { limit, before, from, to } = query
  const parsed: ClosuresQuery = { limit: CLOSURES_DEFAULT_LIMIT }
  if (limit !== undefined) {
    if (typeof limit !== 'string' || !/^\d+$/.test(limit) || !Number.isSafeInteger(Number(limit))
      || Number(limit) < 1 || Number(limit) > CLOSURES_MAX_LIMIT)
      return { ok: false, message: 'limit must be an integer from 1 to 100' }
    parsed.limit = Number(limit)
  }
  if (before !== undefined) {
    if (typeof before !== 'string' || !/^\d+$/.test(before) || !Number.isSafeInteger(Number(before)) || Number(before) < 1)
      return { ok: false, message: 'before must be an integer >= 1' }
    parsed.before = Number(before)
  }
  if (from !== undefined) {
    if (typeof from !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(from))
      return { ok: false, message: 'from must be a day (YYYY-MM-DD)' }
    parsed.from = from
  }
  if (to !== undefined) {
    if (typeof to !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(to))
      return { ok: false, message: 'to must be a day (YYYY-MM-DD)' }
    parsed.to = to
  }
  if (parsed.from !== undefined && parsed.to !== undefined && parsed.from > parsed.to)
    return { ok: false, message: 'from must not be after to' }
  return { ok: true, query: parsed }
}

export interface ClosureHistoryRow {
  closureId: string; sessionId: string; registerId: string; number: number
  businessDay?: string; openedAt: string; closedAt: string
  openedBy?: string; closedBy?: string; approvedBy?: string; approvalVerified: boolean
  storeKey?: string; deviceName?: string
  tillExpected: Record<string, number>; counted: Record<string, number>
  periodSalesTotalMinor: number; periodRefundsTotalMinor: number
  perpetualSalesTotalMinor: number; perpetualRefundsTotalMinor: number
  unsyncedCount: number; unsyncedTotalMinor: number; softwareVersion: string
  orderIds: string[]; movementIds: string[]
}

export function toClosureHistoryRow(stored: StoredClosure): ClosureHistoryRow {
  return {
    closureId: stored.id, sessionId: stored.session_id, registerId: stored.register_id, number: stored.number,
    ...(stored.business_day === null ? {} : { businessDay: stored.business_day }),
    openedAt: stored.opened_at, closedAt: stored.closed_at,
    ...(stored.opened_by === null ? {} : { openedBy: stored.opened_by }),
    ...(stored.closed_by === null ? {} : { closedBy: stored.closed_by }),
    ...(stored.approved_by === null ? {} : { approvedBy: stored.approved_by }),
    approvalVerified: stored.approval_id !== null,
    ...(stored.store_key === null ? {} : { storeKey: stored.store_key }),
    ...(stored.device_name === null ? {} : { deviceName: stored.device_name }),
    tillExpected: stored.till_expected, counted: stored.counted,
    periodSalesTotalMinor: stored.period_sales_total_minor, periodRefundsTotalMinor: stored.period_refunds_total_minor,
    perpetualSalesTotalMinor: stored.perpetual_sales_total_minor, perpetualRefundsTotalMinor: stored.perpetual_refunds_total_minor,
    unsyncedCount: stored.unsynced_count, unsyncedTotalMinor: stored.unsynced_total_minor, softwareVersion: stored.software_version,
    orderIds: stored.order_ids, movementIds: stored.movement_ids,
  }
}
