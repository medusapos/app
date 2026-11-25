import type { OrderStatus } from '@tallyui/components';
import { formatMoney, type StoreOrder } from '@tallyui/core';
import { isRequeueableOrder, type PosOrder } from '@tallyui/pos';
import { formatOrderAddress } from './order-billing';
import { paymentLabel } from './order-detail';
import { storeOrderStatus, type OrdersRow } from './store-orders';

// The words one Orders table row shows; the total is the stored figure, formatted, never a sum the app makes.
export function ordersTableCells(order: PosOrder): {
  customer: string; cashier: string; payment: string; total: string; retryable: boolean;
} {
  const payments = [...new Set(order.payments.map((payment) => paymentLabel(payment.method)))];
  return {
    customer: order.customer?.name || order.customer?.email || 'Guest',
    cashier: typeof order.cashierRef === 'string' && order.cashierRef !== '' ? order.cashierRef : '—',
    payment: payments.length > 0 ? payments.join(', ') : '—',
    total: formatMoney({ amount: order.totalMinor, currency: order.currency }) ?? '',
    // OrdersList's own Retry rule, so the table offers Retry exactly where TallyUI's list did.
    retryable: isRequeueableOrder(order),
  };
}

// A store order no till here created: the store's own number, status and total. It names no cashier, and the
// payment method is left to its sheet, so both read as a dash.
export function storeOrderTableCells(order: StoreOrder): {
  status: OrderStatus; number: string; customer: string; date: string; cashier: string; payment: string; total: string;
} {
  return {
    status: storeOrderStatus(order.status),
    number: `#${order.reference}`,
    customer: order.customer?.name || order.customer?.email || 'Guest',
    date: order.placedAt,
    cashier: '—',
    payment: '—',
    total: formatMoney({ amount: order.totalMinor, currency: order.currency }) ?? '',
  };
}

// The Billing Address cell, the same rule in both tables: a till's sale reads its own stored address (as its receipt
// does), else its store order's as the store answered: "—" when it has none, empty while the answer is out. An unsent
// sale, or one in the offline list, has no store order to read: "—".
export function orderBillingCell(row: OrdersRow, billing: ReadonlyMap<string, string | null>): string {
  const own = row.kind === 'local' ? formatOrderAddress(row.order.customer?.billing) : null;
  if (own) return own;
  const storeId = row.kind === 'store' ? row.order.id : row.storeId;
  if (storeId === undefined) return '—';
  const text = billing.get(storeId);
  return text === undefined ? '' : text ?? '—';
}

// The date a row shows: the till's sale when it was made, a store order when it was placed.
export const orderRowDate = (row: OrdersRow): string => row.kind === 'local' ? row.order.createdAt : row.order.placedAt;
const localDay = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

// v2's day headers: the rows by the device's local calendar day (yyyy-mm-dd) of their shown date, newest day first, each
// day's rows in the order given. Rows whose date can't be read come last, under no day. Every row is in one group.
export function groupOrderRowsByDay(rows: OrdersRow[]): { day: string | null; rows: OrdersRow[] }[] {
  const days = new Map<string, OrdersRow[]>();
  const undated: OrdersRow[] = [];
  for (const row of rows) {
    const date = new Date(orderRowDate(row));
    if (Number.isNaN(date.getTime())) undated.push(row);
    else if (days.has(localDay(date))) days.get(localDay(date))!.push(row);
    else days.set(localDay(date), [row]);
  }
  const groups = [...days].sort(([a], [b]) => b.localeCompare(a)).map(([day, dayRows]) => ({ day, rows: dayRows }));
  return undated.length > 0 ? [...groups, { day: null, rows: undated }] : groups;
}
