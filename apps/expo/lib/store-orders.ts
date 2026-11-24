import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OrderDetailLineItem, OrderDetailTaxLine, OrderStatus } from '@tallyui/components';
import { ConnectorUnauthorizedError, CustomerServiceError, formatMoney, type StoreOrder, type SyncContext } from '@tallyui/core';
import { buildReceiptDataFromStoreOrder, orderFiltersQuery, type OrderFilterValue, type PosOrder } from '@tallyui/pos';
import { ordersScreenFilterFields } from './order-filters';
import { authHeaders, createPosConnector, storeOrderFilters } from './pos-connector';
import type { Session } from './session';

// listOrders' own default page size (its max is 100); WCPOS v2 pages its Orders list the same way.
export const STORE_ORDERS_PER_PAGE = 25;
// As the Customers search: one request once the cashier stops typing.
export const STORE_ORDERS_SEARCH_DEBOUNCE_MS = 250;

// One row of the Orders table: a sale this till holds, or an order only the store has.
export type OrdersRow = { kind: 'local'; key: string; order: PosOrder } | { kind: 'store'; key: string; order: StoreOrder };

// The badge for Medusa's own order status word; a word the app doesn't know reads as pending.
export function storeOrderStatus(status: string): OrderStatus {
  switch (status) {
    case 'completed': case 'archived': return 'completed';
    case 'canceled': return 'canceled';
    case 'requires_action': return 'on-hold';
    default: return 'pending';
  }
}

// This till's unsent sales first, newest first; then the store's orders in the store's order. A store order the till
// created renders as the till's own sale (its cashier, payments and sheet), and no sale is listed twice.
export function mergeOrderRows(unsent: PosOrder[], recent: PosOrder[], store: StoreOrder[]): OrdersRow[] {
  const rows: OrdersRow[] = [...unsent].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((order) => ({ kind: 'local', key: order.id, order }));
  const seen = new Set(rows.map((row) => row.key));
  const local = new Map(recent.map((order) => [order.id, order]));
  for (const order of store) {
    const mine = order.clientOrderId ? local.get(order.clientOrderId) : undefined;
    const row: OrdersRow = mine ? { kind: 'local', key: mine.id, order: mine } : { kind: 'store', key: order.id, order };
    if (seen.has(row.key)) continue;
    seen.add(row.key);
    rows.push(row);
  }
  return rows;
}

// The store order's figures for TallyUI's OrderDetail, from TallyUI's receipt builder as the till's own sheet does.
export function storeOrderDetailFigures(order: StoreOrder): {
  lineItems: OrderDetailLineItem[]; subtotal: string; tax: string; total: string; discount?: string; shipping?: string;
  taxLines: OrderDetailTaxLine[];
} {
  const receipt = buildReceiptDataFromStoreOrder(order, { storeName: '' });
  const money = (amount: number) => formatMoney({ amount, currency: receipt.currency }) ?? '';
  return {
    lineItems: receipt.lineItems.map((line) => ({ name: line.name, quantity: line.quantity, total: money(line.displayAmountMinor) })),
    subtotal: money(receipt.totals.subtotalMinor),
    tax: money(receipt.totals.taxMinor),
    total: money(receipt.totals.totalMinor),
    ...(receipt.totals.discountMinor > 0 ? { discount: `-${money(receipt.totals.discountMinor)}` } : {}),
    // OrderDetail has one Shipping row: the store's shipping lines, as the receipt builder states them, added up.
    ...(receipt.shipping.length > 0
      ? { shipping: money(receipt.shipping.reduce((sum, line) => sum + line.amountMinor, 0)) } : {}),
    taxLines: receipt.totals.taxLines.map((line) => ({ label: line.label, amount: money(line.amountMinor) })),
  };
}

export type StoreOrdersFailure = 'network' | 'other';

// The store's orders, page by page, for the search and filters on screen. A newer request drops an older answer,
// and a change of search, filters or applied count starts again at page 1.
export function useStoreOrders(session: Session, search: string, filters: OrderFilterValue, appliedCount: number,
  onUnauthorized: () => void) {
  const connector = useMemo(() => createPosConnector(), []);
  const filterFields = useMemo(() => ordersScreenFilterFields(storeOrderFilters(session.capabilities)), [session.capabilities]);
  const context = useMemo<SyncContext>(() => ({ connectorId: connector.id, baseUrl: session.baseUrl,
    headers: authHeaders(session.token) }), [connector.id, session.baseUrl, session.token]);
  // The capabilities let listOrders route and accept the register filter (plugin contract 3). Only a register query
  // carries them, so a search without one (1-6 digits too) stays on /admin/orders as before (desk, 2026-11-24).
  const registerContext = useMemo<SyncContext>(() => ({ ...context, capabilities: session.capabilities }),
    [context, session.capabilities]);
  const [debounced, setDebounced] = useState(search.trim());
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), STORE_ORDERS_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);
  const query = useMemo(() => ({ search: debounced, filters, appliedCount }), [debounced, filters, appliedCount]);
  const [paging, setPaging] = useState({ query, page: 1, attempt: 0 });
  const page = paging.query === query ? paging.page : 1;
  const attempt = paging.attempt;
  const [result, setResult] = useState<{ orders: StoreOrder[]; hasMore: boolean; total?: number; unreadable: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<StoreOrdersFailure | null>(null);
  const request = useRef(0);
  const unauthorized = useRef(onUnauthorized);
  useEffect(() => { unauthorized.current = onUnauthorized; }, [onUnauthorized]);

  useEffect(() => {
    const current = ++request.current;
    const listOrders = connector.listOrders;
    setLoading(true);
    if (!listOrders) {
      setFailure('other');
      setLoading(false);
      return;
    }
    listOrders(filters.registerId ? registerContext : context, { page, perPage: STORE_ORDERS_PER_PAGE, ...(debounced ? { search: debounced } : {}),
      ...orderFiltersQuery(filters, 'device') }).then((answer) => {
      if (current !== request.current) return;
      setResult((before) => page === 1 || !before
        ? { orders: answer.orders, hasMore: answer.hasMore, total: answer.total, unreadable: answer.unreadable ?? 0 }
        : { orders: [...before.orders, ...answer.orders], hasMore: answer.hasMore, total: answer.total,
          unreadable: before.unreadable + (answer.unreadable ?? 0) });
      setFailure(null);
      setLoading(false);
    }, (error: unknown) => {
      if (current !== request.current) return;
      setLoading(false);
      if (error instanceof ConnectorUnauthorizedError && error.code === 'unauthorized') {
        unauthorized.current();
        return;
      }
      setFailure(error instanceof CustomerServiceError && error.code === 'network' ? 'network' : 'other');
    });
    // A late answer after a newer request, or after the screen closes, is dropped.
    return () => { ++request.current; };
  }, [connector, context, registerContext, debounced, filters, page, appliedCount, attempt]);

  const loadMore = useCallback(() => setPaging({ query, page: page + 1, attempt }), [query, page, attempt]);
  const retry = useCallback(() => setPaging({ query, page: 1, attempt: attempt + 1 }), [query, attempt]);
  return {
    orders: result?.orders ?? [], loaded: result !== null, hasMore: !!result?.hasMore, total: result?.total,
    unreadable: result?.unreadable ?? 0, loading, failure, loadMore, retry, filterFields,
  };
}
