import type { SalesFilters } from '@tallyui/components';
import { clampClosureScope, comparisonRange, inRange, minorToDecimal, reportOrderFromPosOrder, salesFigures, type Closure, type ClosureContext, type ClosureScope, type PosOrder, type SalesFigures } from '@tallyui/pos';
import type { ClosureHistoryEntry } from './closure-history';

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

export type ClosureTableRow = {
  id: string; number: number; closedAt: string; registerName: string; cashierName: string;
  salesMinor: number; countedMinor: number | null; varianceMinor: number | null;
};

export function closureTableRow(row: Closure, registerNames: Record<string, string>): ClosureTableRow {
  const { register_name, closed_by_name } = row.breakdowns;
  return {
    id: row.id, number: row.number, closedAt: row.closed_at,
    registerName: typeof register_name === 'string' && register_name ? register_name : registerNames[row.register_id] || row.register_id.slice(0, 8),
    cashierName: typeof closed_by_name === 'string' && closed_by_name ? closed_by_name : '—',
    salesMinor: row.period_sales_total_minor, countedMinor: Object.values(row.counted).reduce((total, amount) => total + amount, 0),
    varianceMinor: closureVarianceMinor(row),
  };
}

export function historyTableRow(entry: ClosureHistoryEntry, registerName: string, cashierNames: Record<string, string>): ClosureTableRow {
  const countedMinor = entry.counted ? Object.values(entry.counted).reduce((total, amount) => total + amount, 0) : null;
  return {
    id: entry.closureId, number: entry.number, closedAt: entry.closedAt,
    registerName: registerName || entry.registerId?.slice(0, 8) || '—',
    cashierName: entry.closedBy ? cashierNames[entry.closedBy] ?? entry.closedBy : '—',
    salesMinor: entry.periodSalesTotalMinor, countedMinor,
    varianceMinor: countedMinor !== null && entry.tillExpected
      ? countedMinor - Object.values(entry.tillExpected).reduce((total, amount) => total + amount, 0) : null,
  };
}

export function varianceLabel(varianceMinor: number, ctx: Pick<ClosureContext, 'formatMoney' | 'exponent'>): string {
  return varianceMinor === 0 ? 'Exact'
    : `${ctx.formatMoney(minorToDecimal(Math.abs(varianceMinor), ctx.exponent))} ${varianceMinor < 0 ? 'short' : 'over'}`;
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
