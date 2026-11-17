import { formatMoney } from '@tallyui/core';
import { isRequeueable, type PosOrder } from '@tallyui/pos';
import { paymentLabel } from './order-detail';

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
    retryable: order.syncStatus === 'rejected' && isRequeueable(order.error?.code),
  };
}
