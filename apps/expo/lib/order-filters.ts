import type { OrderFilterBarProps, OrderFilterOption } from '@tallyui/components';
import { ORDER_FILTER_FIELDS, type OrderFilterField, type StoreOrder } from '@tallyui/core';
import { inRange, type OrderFilterValue, type PosOrder } from '@tallyui/pos';

// The bar's candidate fields, in the bar's order (cashier, register, store and channel are left out of the bar).
const ORDERS_SCREEN_CANDIDATE_FIELDS: readonly OrderFilterField[] = ['status', 'paymentMethod', 'customerId', 'dateRange'];

// The fields the bar shows: only those the connector's listOrders honours (its `orderFilters` capability), since it
// refuses any other. A connector without the capability filters nothing, so it gets none. Medusa drops payment method.
export function ordersScreenFilterFields(supported: readonly OrderFilterField[] | undefined): OrderFilterField[] {
  return ORDERS_SCREEN_CANDIDATE_FIELDS.filter((field) => ORDER_FILTER_FIELDS.includes(field) && !!supported?.includes(field));
}

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

// Customers come from the till's sales and the store orders on screen; the till's sales name them first.
export function orderFilterOptions(orders: PosOrder[], storeOrders: StoreOrder[] = []): Required<Pick<NonNullable<OrderFilterBarProps['options']>,
  'status' | 'paymentMethod' | 'customer'>> {
  const methods = new Set(orders.flatMap((order) => order.payments.map((payment) => payment.method)));
  const paymentMethod: NonNullable<OrderFilterBarProps['options']>['paymentMethod'] = [];
  if (methods.has('cash')) paymentMethod.push({ value: 'cash', label: 'Cash', kind: 'cash' });
  if (methods.has('external')) paymentMethod.push({ value: 'external', label: 'Card', kind: 'card' });
  const customers = new Map<string, string>();
  for (const { customer } of [...orders, ...storeOrders]) {
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
