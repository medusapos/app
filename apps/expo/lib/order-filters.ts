import type { OrderFilterBarProps, OrderFilterOption } from '@tallyui/components';
import type { OrderFilterField } from '@tallyui/core';
import { inRange, type OrderFilterValue, type PosOrder } from '@tallyui/pos';

// These are one till's own sales; cashier names are not on local orders, so omit cashier/register/store.
export const ORDERS_SCREEN_FILTER_FIELDS: readonly OrderFilterField[] = ['status', 'paymentMethod', 'customerId', 'dateRange'];

export type MedusaOrderStatus = 'completed' | 'pending' | 'canceled';

export const MEDUSA_ORDER_STATUS_OPTIONS: OrderFilterOption[] = [
  { value: 'completed', label: 'Completed' },
  { value: 'pending', label: 'Pending' },
  // Label is British spelling to match TallyUI's badge; the value stays Medusa's `canceled`.
  { value: 'canceled', label: 'Cancelled' },
];

export function medusaOrderStatus(order: PosOrder): MedusaOrderStatus {
  // The plugin's tally-order-create workflow completes applied orders via completeOrderWorkflow;
  // rejected sales leave no live order (tally-ledger-resolve cancels them). Unsynced sales are pending.
  switch (order.syncStatus) {
    case 'applied': return 'completed';
    case 'pending': return 'pending';
    case 'rejected': return 'canceled';
  }
}

export function orderFilterOptions(orders: PosOrder[]): Required<Pick<NonNullable<OrderFilterBarProps['options']>,
  'status' | 'paymentMethod' | 'customer'>> {
  const methods = new Set(orders.flatMap((order) => order.payments.map((payment) => payment.method)));
  const paymentMethod: NonNullable<OrderFilterBarProps['options']>['paymentMethod'] = [];
  if (methods.has('cash')) paymentMethod.push({ value: 'cash', label: 'Cash', kind: 'cash' });
  if (methods.has('external')) paymentMethod.push({ value: 'external', label: 'Card', kind: 'card' });
  const customers = new Map<string, string>();
  for (const { customer } of orders) {
    if (customer?.id && !customers.has(customer.id)) {
      customers.set(customer.id, customer.name || customer.email || customer.id);
    }
  }
  return {
    status: MEDUSA_ORDER_STATUS_OPTIONS,
    paymentMethod,
    customer: Array.from(customers, ([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label)),
  };
}

export function filterOrders(orders: PosOrder[], search: string, value: OrderFilterValue, timezone: string): PosOrder[] {
  const query = search.trim().toLowerCase().replace(/^#/, '');
  return orders.filter((order) => {
    if (query && ![
      order.id, order.serverRefs?.displayId, order.customer?.name, order.customer?.email,
      ...order.lines.flatMap((line) => [line.name, line.sku]),
    ].some((text) => text?.toLowerCase().includes(query))) return false;
    if (value.status && medusaOrderStatus(order) !== value.status) return false;
    if (value.paymentMethod && !order.payments.some((payment) => payment.method === value.paymentMethod)) return false;
    if (value.customerId && order.customer?.id !== value.customerId) return false;
    if (value.dateRange && !inRange(order.createdAt, value.dateRange, timezone)) return false;
    return true;
  });
}
