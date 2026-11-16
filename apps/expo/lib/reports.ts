import type { SalesFilters } from '@tallyui/components';
import { clampClosureScope, comparisonRange, inRange, reportOrderFromPosOrder, salesFigures, type Closure, type ClosureScope, type PosOrder, type SalesFigures } from '@tallyui/pos';

export function localDay(at: Date): string {
  return `${String(at.getFullYear()).padStart(4, '0')}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
}

export function localDayStartIso(day: string): string {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(year, month - 1, date).toISOString();
}

export function paymentMethodLabel(method: string): string {
  return method === 'cash' ? 'Cash' : method === 'external' ? 'Card' : method.charAt(0).toUpperCase() + method.slice(1);
}

export function salesRoomFigures(orders: readonly PosOrder[], filters: SalesFilters, currency: string): {
  figures: SalesFigures; notSentCount: number; leftOutCount: number;
} {
  const counted = orders.filter((order) => order.currency.toUpperCase() === currency.toUpperCase()
    && (filters.registerId === null || order.registerId === filters.registerId)
    && (filters.status === 'all' || order.syncStatus === filters.status));
  const compare = comparisonRange(filters.range, filters.compare, filters.preset === 'custom' ? undefined : filters.preset);
  const reportOrders = counted.map((order) => reportOrderFromPosOrder(order)).map((order) => ({
    ...order, payments: order.payments.map((payment) => ({ ...payment, label: payment.label || paymentMethodLabel(payment.method) })),
  }));
  return {
    figures: salesFigures({ orders: reportOrders, range: filters.range, compare, timezone: 'device' }),
    notSentCount: counted.filter((order) => order.syncStatus === 'pending' && inRange(order.createdAt, filters.range, 'device')).length,
    leftOutCount: orders.filter((order) => order.currency.toUpperCase() !== currency.toUpperCase()
      && inRange(order.createdAt, filters.range, 'device')).length,
  };
}

export function closureScopeFor(input: { today: string; boundRegisterId: string | null | undefined; storeKey: string }): ClosureScope {
  return clampClosureScope({
    from: input.today, to: input.today, registerId: input.boundRegisterId || 'unbound', storeKey: input.storeKey,
  }, input.today);
}

export function closureVarianceMinor(row: Pick<Closure, 'variance'>): number {
  return Object.values(row.variance).reduce((total, amount) => total + amount, 0);
}

export const CSV_LABELS: Record<string, string> = {
  'reports.csv_business_day': 'Business day',
  'reports.csv_closure': 'Closure',
  'reports.csv_register': 'Register',
  'reports.csv_store': 'Store',
  'reports.csv_opened': 'Opened',
  'reports.csv_closed': 'Closed',
  'reports.csv_closer': 'Closer',
  'reports.document.expected': 'Expected',
  'register.counted': 'Counted',
  'register.variance': 'Variance',
  'reports.csv_status': 'Status',
  'register.unknown_cashier': 'Cashier',
  'register.short': 'short',
  'register.over': 'over',
  'reports.exact': 'Exact',
  'register.unsynced': 'Unsynced',
  'reports.corrected': 'Corrected',
};

export function csvLabel(key: string): string {
  return CSV_LABELS[key] ?? key;
}

export function closuresCsvFilename(scope: Pick<ClosureScope, 'from' | 'to'>): string {
  return `closures-${scope.from}-${scope.to}.csv`;
}

export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.hidden = true;
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
