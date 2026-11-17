import type { OrderDetailLineItem, OrderStatus } from '@tallyui/components';
import { formatMoney } from '@tallyui/core';
import { buildReceiptDataFromPosOrder, type PosOrder, type PosOrderPayment } from '@tallyui/pos';
import { medusaOrderStatus } from './order-filters';

// The sheet's badge uses the Orders filter's Medusa words; TallyUI's key for "canceled" is 'cancelled'.
export function orderStatusBadge(order: PosOrder): OrderStatus {
  switch (medusaOrderStatus(order)) {
    case 'completed': return 'completed';
    case 'pending': return 'pending';
    case 'canceled': return 'cancelled';
  }
}

// Every figure is TallyUI's receipt builder's, the same the reprinted receipt shows; the app adds no money itself.
export function orderDetailFigures(order: PosOrder): {
  lineItems: OrderDetailLineItem[]; subtotal: string; tax: string; total: string;
} {
  const receipt = buildReceiptDataFromPosOrder(order, { storeName: '' });
  const money = (amount: number) => formatMoney({ amount, currency: receipt.currency }) ?? '';
  return {
    lineItems: receipt.lineItems.map((line) => ({ name: line.name, quantity: line.quantity, total: money(line.displayAmountMinor) })),
    subtotal: money(receipt.totals.subtotalMinor),
    tax: money(receipt.totals.taxMinor),
    total: money(receipt.totals.totalMinor),
  };
}

// The words TallyUI's OrdersList uses for a payment.
export function paymentLabel(method: PosOrderPayment['method']): string {
  return method === 'cash' ? 'Cash' : 'Card terminal';
}
