import { describe, expect, it } from 'vitest';
import type { PosOrder } from '@tallyui/pos';
import { filterOrders, medusaOrderStatus, orderFilterOptions, ordersScreenFilterFields } from './order-filters';

function order(overrides: Partial<PosOrder> = {}): PosOrder {
  return {
    id: 'local-order', createdAt: '2026-11-10T12:00:00.000Z', syncStatus: 'applied',
    customer: null, lines: [{ name: 'Blue shirt', sku: 'SHIRT-BLUE' }], payments: [{ method: 'cash' }],
    ...overrides,
  } as PosOrder;
}

describe('order filters', () => {
  it('maps sync statuses to Medusa order statuses', () => {
    expect(medusaOrderStatus(order({ syncStatus: 'applied' }))).toBe('completed');
    expect(medusaOrderStatus(order({ syncStatus: 'pending' }))).toBe('pending');
    expect(medusaOrderStatus(order({ syncStatus: 'rejected' }))).toBe('canceled');
  });

  it('filters completed and canceled orders by their sync status', () => {
    const applied = order();
    const pending = order({ id: 'pending', syncStatus: 'pending' });
    const rejected = order({ id: 'rejected', syncStatus: 'rejected' });
    const orders = [pending, applied, rejected];
    expect(filterOrders(orders, '', { status: 'completed' }, 'UTC')).toEqual([applied]);
    expect(filterOrders(orders, '', { status: 'canceled' }, 'UTC')).toEqual([rejected]);
  });

  it('keeps card payments including split cash and card orders', () => {
    const cash = order();
    const card = order({ id: 'card', payments: [{ id: 'card', method: 'external', amountMinor: 1000 }] });
    const split = order({ id: 'split', payments: [
      { id: 'cash', method: 'cash', amountMinor: 500 },
      { id: 'card', method: 'external', amountMinor: 500 },
    ] });
    expect(filterOrders([cash, card, split], '', { paymentMethod: 'external' }, 'UTC')).toEqual([card, split]);
  });

  it('keeps only the selected customer\'s orders', () => {
    const selected = order({ customer: { id: 'customer-a', name: 'Alice' } });
    const other = order({ id: 'other', customer: { id: 'customer-b', name: 'Alice' } });
    expect(filterOrders([other, selected, order()], '', { customerId: 'customer-a' }, 'UTC')).toEqual([selected]);
  });

  it('keeps only the selected register\'s orders', () => {
    const mine = order({ registerId: 'till-a' });
    const other = order({ id: 'other', registerId: 'till-b' });
    expect(filterOrders([other, mine], '', { registerId: 'till-a' }, 'UTC')).toEqual([mine]);
  });

  it('searches order references, customer details and lines, ignoring case and surrounding whitespace', () => {
    const matching = order({
      customer: { id: 'customer-a', name: 'Alice Smith', email: 'alice@example.test' },
      serverRefs: { orderId: 'server-order', displayId: '1042', totalMinor: 1000 },
    });
    const other = order({ id: 'other', lines: [] });
    const orders = [other, matching];
    for (const search of ['1042', ' #1042 ', 'aLiCe SmItH', 'shirt-blue', 'LOCAL-ORDER', 'EXAMPLE.TEST', 'blue shirt']) {
      expect(filterOrders(orders, search, {}, 'UTC')).toEqual([matching]);
    }
    expect(filterOrders(orders, 'missing', {}, 'UTC')).toEqual([]);
    expect(filterOrders(orders, '##1042', {}, 'UTC')).toEqual([]);
    expect(filterOrders(orders, '   ', {}, 'UTC')).toEqual(orders);
  });

  it('includes both boundary days of a UTC date range and excludes the next day', () => {
    const first = order({ id: 'first', createdAt: '2026-11-10T00:00:00.000Z' });
    const last = order({ id: 'last', createdAt: '2026-11-11T23:59:59.999Z' });
    const after = order({ id: 'after', createdAt: '2026-11-12T00:00:00.000Z' });
    expect(filterOrders([first, after, last], '', {
      dateRange: { from: '2026-11-10', to: '2026-11-11' },
    }, 'UTC')).toEqual([first, last]);
  });

  it('combines criteria with AND and preserves order without criteria', () => {
    const selected = order({ customer: { id: 'customer-a' } });
    const pending = order({ id: 'pending', customer: { id: 'customer-a' }, syncStatus: 'pending' });
    const other = order({ id: 'other', customer: { id: 'customer-b' } });
    const orders = [other, pending, selected];
    expect(filterOrders(orders, '', { status: 'completed', customerId: 'customer-a' }, 'UTC')).toEqual([selected]);
    expect(filterOrders(orders, '', {}, 'UTC')).toEqual(orders);
    expect(filterOrders(orders, '', {
      cashierId: 'ignored', storeId: 'ignored', createdVia: 'ignored',
    }, 'UTC')).toEqual(orders);
  });

  it('offers present payments, distinct sorted customer labels and all Medusa statuses', () => {
    const named = order({ customer: { id: 'named', name: 'Zoe', email: 'unused@example.test' } });
    const emailed = order({ customer: { id: 'emailed', email: 'amy@example.test' },
      payments: [{ id: 'card', method: 'external', amountMinor: 1000 }] });
    const idOnly = order({ customer: { id: 'customer-b' } });
    const noId = order({ customer: { name: 'Skipped' } });
    const cashOption = { value: 'cash', label: 'Cash', kind: 'cash' };
    const cardOption = { value: 'external', label: 'Card', kind: 'card' };
    const status = [
      { value: 'completed', label: 'Completed' },
      { value: 'pending', label: 'Pending' },
      { value: 'canceled', label: 'Cancelled' },
    ];
    expect(orderFilterOptions([emailed, named, idOnly, named, noId, order()])).toEqual({
      status,
      paymentMethod: [cashOption, cardOption],
      customer: [
        { value: 'emailed', label: 'amy@example.test' },
        { value: 'customer-b', label: 'customer-b' },
        { value: 'named', label: 'Zoe' },
      ],
    });
    expect(orderFilterOptions([named]).paymentMethod).toEqual([cashOption]);
    expect(orderFilterOptions([emailed]).paymentMethod).toEqual([cardOption]);
    expect(orderFilterOptions([])).toEqual({ status, paymentMethod: [], customer: [] });
  });
});

describe('ordersScreenFilterFields', () => {
  it('shows the fields the connector advertises, in the bar\'s order, and none without the capability', () => {
    expect(ordersScreenFilterFields(['status', 'customerId', 'dateRange'])).toEqual(['status', 'customerId', 'dateRange']);
    expect(ordersScreenFilterFields(['dateRange', 'paymentMethod', 'customerId', 'status']))
      .toEqual(['status', 'paymentMethod', 'customerId', 'dateRange']);
    expect(ordersScreenFilterFields(['status', 'cashierId', 'registerId', 'storeId', 'createdVia'])).toEqual(['status', 'registerId']);
    expect(ordersScreenFilterFields(undefined)).toEqual([]);
  });
});
