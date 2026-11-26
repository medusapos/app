import { useMemo } from 'react';
import type { SyncContext } from '@tallyui/core';
import { salesRangeQuery, useStoreOrdersInRange, type PosOrder } from '@tallyui/pos';
import { authHeaders, createPosConnector, storeOrderFilters } from './pos-connector';
import { localDay, localDayStartIso, storeRefundsByLocalOrder, storeRefundsReadable, type StoreRefunds } from './reports';
import type { Session } from './session';

/** Reports' read of the store's refunds: `off` when the store records none, so the Refunds card is left out. */
export type ReportRefundsRead = { state: 'off' } | { state: 'reading' } | { state: 'failed' }
  | { state: 'ready'; refunds: StoreRefunds };

function dayAfter(day: string, by = 1): string {
  const [year, month, date] = day.split('-').map(Number);
  return localDay(new Date(year, month - 1, date + by));
}

// The store's orders over the report's whole window (both periods), read online and never stored, matched to the
// till's own sales. `window` is the same `[min(range.from, compare.from), range.to]` the local watch covers.
// The read is wider than the window: the store's `created_at` is when a sale reached the store, not when it was rung
// up, so it runs from the day before `window.from` (a store clock behind the till's) up to today (a sale that synced
// after the range). Matching keeps only the till's own sales in the window, so the wider read can't over-count.
export function useReportStoreRefunds(session: Session | null, window: { from: string; to: string } | null,
  sales: readonly PosOrder[]): ReportRefundsRead {
  const connector = useMemo(() => createPosConnector(), []);
  const readable = !!session && !!window && storeRefundsReadable(session.capabilities);
  const baseUrl = session?.baseUrl;
  const token = session?.token;
  const capabilities = session?.capabilities;
  const context = useMemo<SyncContext | null>(() => (readable && baseUrl !== undefined && token !== undefined
    ? { connectorId: connector.id, baseUrl, headers: authHeaders(token), capabilities } : null),
  [readable, connector.id, baseUrl, token, capabilities]);
  const today = localDay(new Date());
  const after = window ? localDayStartIso(dayAfter(window.from, -1)) : null;
  const before = window ? localDayStartIso(dayAfter(today > window.to ? today : window.to)) : null;
  const query = useMemo(() => (readable && after && before
    ? salesRangeQuery({ after, before }, storeOrderFilters(capabilities)) : null), [readable, after, before, capabilities]);
  const read = useStoreOrdersInRange(connector, context, query);
  const refunds = useMemo(() => storeRefundsByLocalOrder(sales, read.orders), [sales, read.orders]);
  if (!readable) return { state: 'off' };
  if (read.error) return { state: 'failed' };
  if (read.unreadable > 0) return { state: 'failed' }; // a store order the connector could not parse: the total would be short
  if (!read.complete) return { state: 'reading' };
  return { state: 'ready', refunds };
}
