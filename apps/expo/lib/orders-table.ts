import type { OrderStatus } from '@tallyui/components';
import { formatMoney, type StoreOrder } from '@tallyui/core';
import { isRequeueableOrder, type PosOrder } from '@tallyui/pos';
import { paymentLabel } from './order-detail';
import { storeOrderStatus } from './store-orders';

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
