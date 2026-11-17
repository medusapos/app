import type { SalesFilters } from '@tallyui/components';
import { clampClosureScope, closureVariance, comparisonRange, inRange, minorToDecimal, reportOrderFromPosOrder, salesFigures, type Closure, type ClosureContext, type ClosureScope, type DatePreset, type DayRange, type PosOrder, type SalesFigures } from '@tallyui/pos';
import { dayBefore, type ClosureHistoryEntry } from './closure-history';

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

/** Reports > Closures filters; `registerId: null` is this till's register. */
export type ClosureFilters = { preset: DatePreset | 'custom'; range: DayRange; registerId: string | null; cashierId: string | null };

/** The days the store's closure list covers: the bound register's today comes from the till's own table instead. */
export function closureHistoryWindow(range: DayRange, today: string, ownRegister: boolean): { from: string; to: string } | null {
  const yesterday = dayBefore(today);
  const to = ownRegister && yesterday < range.to ? yesterday : range.to;
  return range.from > to ? null : { from: range.from, to };
}

export function showsTodayClosures(range: DayRange, today: string, ownRegister: boolean): boolean {
  return ownRegister && range.from <= today && today <= range.to;
}

export function byCashier<T>(rows: T[], cashierId: string | null, cashierOf: (row: T) => string | null | undefined): T[] {
  return cashierId === null ? rows : rows.filter((row) => cashierOf(row) === cashierId);
}

export function closureCashierOptions(ids: Iterable<string>, names: Record<string, string>): { value: string; label: string }[] {
  return [...new Set(ids)].map((id) => ({ value: id, label: names[id] || id }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function closureVarianceMinor(row: Pick<Closure, 'variance'>): number {
  return Object.values(row.variance).reduce((total, amount) => total + amount, 0);
}

export type ClosureTableRow = {
  id: string; number: number; day: string; closedAt: string; registerName: string; cashierName: string;
  salesMinor: number; countedMinor: number | null; varianceMinor: number | null;
};

export function closureTableRow(row: Closure, registerNames: Record<string, string>): ClosureTableRow {
  const { register_name, closed_by_name } = row.breakdowns;
  return {
    id: row.id, number: row.number, day: row.business_day || localDay(new Date(row.closed_at)), closedAt: row.closed_at,
    registerName: typeof register_name === 'string' && register_name ? register_name : registerNames[row.register_id] || row.register_id.slice(0, 8),
    cashierName: typeof closed_by_name === 'string' && closed_by_name ? closed_by_name : '—',
    salesMinor: row.period_sales_total_minor, countedMinor: Object.values(row.counted).reduce((total, amount) => total + amount, 0),
    varianceMinor: closureVarianceMinor(row),
  };
}

export function historyTableRow(entry: ClosureHistoryEntry, registerName: string, cashierNames: Record<string, string>): ClosureTableRow {
  const countedMinor = entry.counted ? Object.values(entry.counted).reduce((total, amount) => total + amount, 0) : null;
  return {
    id: entry.closureId, number: entry.number, day: entry.businessDay || localDay(new Date(entry.closedAt)), closedAt: entry.closedAt,
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

export type ClosureDay = { day: string; rows: ClosureTableRow[]; countedMinor: number | null; varianceMinor: number | null };

const addKnown = (total: number | null, amount: number | null) => amount === null ? total : (total ?? 0) + amount;

/** Groups closure rows by day in order of first appearance, with the day's known counted and variance totals. */
export function closureDays(rows: ClosureTableRow[]): ClosureDay[] {
  const days: ClosureDay[] = [];
  for (const row of rows) {
    let group = days.find((day) => day.day === row.day);
    if (!group) days.push(group = { day: row.day, rows: [], countedMinor: null, varianceMinor: null });
    group.rows.push(row);
    group.countedMinor = addKnown(group.countedMinor, row.countedMinor);
    group.varianceMinor = addKnown(group.varianceMinor, row.varianceMinor);
  }
  return days;
}

export function closureDayLabel(day: string, today: string, locale: string): string {
  if (day === today) return 'Today';
  if (day === dayBefore(today)) return 'Yesterday';
  return new Intl.DateTimeFormat(locale, { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' })
    .format(new Date(`${day}T00:00:00Z`));
}

export function closureDayTotal(group: Pick<ClosureDay, 'countedMinor' | 'varianceMinor'>,
  ctx: Pick<ClosureContext, 'formatMoney' | 'exponent'>): string {
  if (group.countedMinor === null) return '';
  const counted = `${ctx.formatMoney(minorToDecimal(group.countedMinor, ctx.exponent))} counted`;
  return group.varianceMinor === null ? counted : `${counted} · ${varianceLabel(group.varianceMinor, ctx)}`;
}

/**
 * The closure a store history row opens: the device's own closure when it holds that row (frozen, so printable),
 * else one built from the store's figures when both counted and till-expected came back, else none.
 */
export function historyClosure(entry: ClosureHistoryEntry, local: Closure[]): { closure: Closure; frozen: boolean } | null {
  const own = local.find((row) => row.id === entry.closureId || row.server_closure_id === entry.closureId);
  if (own) return { closure: own, frozen: true };
  if (!entry.counted || !entry.tillExpected) return null;
  return { frozen: false, closure: {
    id: entry.closureId, session_id: '', register_id: entry.registerId ?? '',
    ...(entry.businessDay ? { business_day: entry.businessDay } : {}), number: entry.number,
    opened_at: entry.openedAt, closed_at: entry.closedAt, till_expected: entry.tillExpected, expected: entry.tillExpected,
    counted: entry.counted, variance: closureVariance(entry.counted, entry.tillExpected),
    period_sales_total_minor: entry.periodSalesTotalMinor, period_refunds_total_minor: 0, perpetual_sales_total_minor: 0,
    perpetual_refunds_total_minor: 0, unsynced_count: 0, unsynced_total_minor: 0, software_version: '', breakdowns: {},
    order_ids: [], movement_ids: [], print_count: 0,
  } };
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
