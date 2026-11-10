import { clampClosureScope, type Closure, type ClosureScope, type PosOrder } from '@tallyui/pos';

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

export type SalesMethodTotal = { method: string; label: string; amountMinor: number };
export type SalesSummary = {
  count: number; grossMinor: number; methods: SalesMethodTotal[]; notSentCount: number; leftOutCount: number;
};

export function summarizeSales(orders: readonly PosOrder[], day: string, currency: string): SalesSummary {
  const summary: SalesSummary = { count: 0, grossMinor: 0, methods: [], notSentCount: 0, leftOutCount: 0 };
  const methods = new Map<string, number>();
  for (const order of orders) {
    if (localDay(new Date(order.createdAt)) !== day) continue;
    if (order.currency.toUpperCase() !== currency.toUpperCase()) {
      summary.leftOutCount += 1;
      continue;
    }
    summary.count += 1;
    summary.grossMinor += order.totalMinor;
    if (order.syncStatus === 'pending') summary.notSentCount += 1;
    for (const payment of order.payments) {
      methods.set(payment.method, (methods.get(payment.method) ?? 0) + payment.amountMinor);
    }
  }
  summary.methods = [...methods].map(([method, amountMinor]) => ({ method, label: paymentMethodLabel(method), amountMinor }))
    .sort((a, b) => {
      const rankA = a.method === 'cash' ? 0 : a.method === 'external' ? 1 : 2;
      const rankB = b.method === 'cash' ? 0 : b.method === 'external' ? 1 : 2;
      return rankA - rankB || a.method.localeCompare(b.method);
    });
  return summary;
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
