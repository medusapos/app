import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OrderDetailLineItem, OrderDetailTaxLine, OrderStatus } from '@tallyui/components';
import { ConnectorUnauthorizedError, CustomerServiceError, formatMoney, type StoreOrder, type SyncContext } from '@tallyui/core';
import { buildReceiptDataFromStoreOrder, orderFiltersQuery, type OrderFilterValue, type PosOrder } from '@tallyui/pos';
import { loadOrderBilling } from './order-billing';
import { ordersScreenFilterFields } from './order-filters';
import { authHeaders, createPosConnector, storeOrderFilters } from './pos-connector';
import { PARTIAL_REFUND_PLUGIN_CONTRACT, REFUND_LINES_PLUGIN_CONTRACT } from './plugin-contract';
import type { Session } from './session';

// listOrders' own default page size (its max is 100); WCPOS v2 pages its Orders list the same way.
export const STORE_ORDERS_PER_PAGE = 25;
// As the Customers search: one request once the cashier stops typing.
export const STORE_ORDERS_SEARCH_DEBOUNCE_MS = 250;

// One row of the Orders table: a sale this till holds (`storeId` when it stands for that store order), or an order only
// the store has.
export type OrdersRow = { kind: 'local'; key: string; order: PosOrder; storeId?: string }
  | { kind: 'store'; key: string; order: StoreOrder };

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
    const row: OrdersRow = mine ? { kind: 'local', key: mine.id, order: mine, storeId: order.id } : { kind: 'store', key: order.id, order };
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
const NO_BILLING: ReadonlyMap<string, string | null> = new Map();

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
  // The listed orders' billing addresses by store order id, for the store and token they were read with. Each read
  // outlives a newer page, search or filter; per id, a later read's answer wins. A new store or token starts empty.
  const [billing, setBilling] = useState<{ context: SyncContext; byId: ReadonlyMap<string, string | null> }>(
    () => ({ context, byId: new Map() }));
  const billingReads = useRef({ context, live: true, sent: 0, applied: new Map<string, number>() });
  useEffect(() => {
    const reads = { context, live: true, sent: 0, applied: new Map<string, number>() };
    billingReads.current = reads;
    return () => { reads.live = false; };
  }, [context]);
  const readBilling = useCallback((ids: string[]) => {
    const reads = billingReads.current;
    const sent = ++reads.sent;
    // The rows never wait for it; only a refused session is acted on, any other failure leaves the cells empty.
    loadOrderBilling(reads.context, ids).then((found) => {
      const fresh = [...found].filter(([id]) => reads.live && (reads.applied.get(id) ?? 0) < sent);
      if (fresh.length === 0) return;
      for (const [id] of fresh) reads.applied.set(id, sent);
      setBilling((before) => ({ context: reads.context,
        byId: new Map([...(before.context === reads.context ? before.byId : []), ...fresh]) }));
    }, (error: unknown) => {
      if (reads.live && error instanceof ConnectorUnauthorizedError && error.code === 'unauthorized') unauthorized.current();
    });
  }, []);

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
      readBilling(answer.orders.map((order) => order.id));
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
  }, [connector, context, registerContext, debounced, filters, page, appliedCount, attempt, readBilling]);

  const loadMore = useCallback(() => setPaging({ query, page: page + 1, attempt }), [query, page, attempt]);
  const retry = useCallback(() => setPaging({ query, page: 1, attempt: attempt + 1 }), [query, attempt]);
  return {
    orders: result?.orders ?? [], loaded: result !== null, hasMore: !!result?.hasMore, total: result?.total,
    unreadable: result?.unreadable ?? 0, loading, failure, loadMore, retry, filterFields,
    billing: billing.context === context ? billing.byId : NO_BILLING,
  };
}

// Reread the open order with capabilities for refund lines at contract 6, and for sold figures and returned quantities
// at 7 even without a till refund. Until it arrives or if it fails, the form refuses any missing figures on the list copy.
export function useStoreOrderWithRefundLines(session: Session, storeOrder: StoreOrder | null, appliedCount: number): StoreOrder | null {
  const connector = useMemo(() => createPosConnector(), []);
  const id = storeOrder?.id;
  const refundCount = storeOrder?.refunds.length ?? 0;
  const contract = session.capabilities?.pluginContract ?? 0;
  const wanted = !!id && (contract >= PARTIAL_REFUND_PLUGIN_CONTRACT || (refundCount > 0 && contract >= REFUND_LINES_PLUGIN_CONTRACT));
  const key = `${id}\n${refundCount}\n${appliedCount}`;
  const [read, setRead] = useState<{ key: string; order: StoreOrder | null } | null>(null);
  useEffect(() => {
    const getOrders = connector.getOrders;
    if (!wanted || !id || !getOrders) return;
    const controller = new AbortController();
    getOrders({ connectorId: connector.id, baseUrl: session.baseUrl, headers: authHeaders(session.token),
      capabilities: session.capabilities, signal: controller.signal }, [id]).then((orders) => {
      if (!controller.signal.aborted) setRead({ key, order: orders.find((order) => order.id === id) ?? null });
    }, () => {
      if (!controller.signal.aborted) setRead({ key, order: null });
    });
    // A newer read aborts this one, and its late answer is dropped.
    return () => controller.abort();
  }, [connector, wanted, id, key, session.baseUrl, session.token, session.capabilities]);
  if (!wanted || !storeOrder) return storeOrder;
  return read?.key === key && read.order?.id === storeOrder.id ? read.order : storeOrder;
}
