// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SalesFilters } from '@tallyui/components';
import { createOrderBuilder, exportCsv, finalizeOrder, selectClosureRows, type Closure, type PosOrder } from '@tallyui/pos';
import { closureScopeFor, closuresCsvFilename, closureVarianceMinor, csvLabel, downloadCsv, localDay, localDayStartIso, paymentMethodLabel, salesRoomFigures } from './reports';

const today = '2026-11-10';
const storeKey = 'https://store.test';
function order(overrides: Partial<PosOrder> = {}): PosOrder {
  const currency = overrides.currency ?? 'EUR';
  const builder = createOrderBuilder({ currency, taxContext: { pricesIncludeTax: false, getTaxRatePpm: () => 0 } });
  builder.addLine({ productId: 'shirt', name: 'Shirt', unitPrice: { amount: overrides.totalMinor ?? 1200, currency } });
  builder.addPayment({ method: 'cash', amountMinor: overrides.totalMinor ?? 1200 });
  return { ...finalizeOrder(builder.getSnapshot()), id: 'order', createdAt: new Date(2026, 10, 10, 12, 0).toISOString(),
    syncStatus: 'applied', ...overrides };
}
function closure(overrides: Partial<Closure> = {}): Closure {
  return {
    id: 'closure', session_id: 'session', register_id: 'register-1', store_key: storeKey, business_day: today, number: 1,
    opened_at: new Date(2026, 10, 10, 8).toISOString(), closed_at: new Date(2026, 10, 10, 12).toISOString(),
    till_expected: { cash: 1000 }, expected: { cash: 1000 }, counted: { cash: 1000 }, variance: { cash: 0 },
    period_sales_total_minor: 1000, period_refunds_total_minor: 0, perpetual_sales_total_minor: 1000, perpetual_refunds_total_minor: 0,
    unsynced_count: 0, unsynced_total_minor: 0, software_version: 'test', breakdowns: {},
    order_ids: [], movement_ids: [], print_count: 0, ...overrides,
  };
}
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;
afterEach(() => {
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  vi.restoreAllMocks();
});

describe('localDay', () => {
  it('formats the local calendar day zero-padded', () => {
    expect(localDay(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });
  it('localDayStartIso is local midnight of that day', () => {
    expect(localDayStartIso(today)).toBe(new Date(2026, 10, 10).toISOString());
    expect(localDay(new Date(localDayStartIso(today)))).toBe(today);
  });
});

describe('paymentMethodLabel', () => {
  it('capitalises other methods', () => {
    expect(paymentMethodLabel('gift_card')).toBe('Gift_card');
  });
});

describe('salesRoomFigures', () => {
  const filters: SalesFilters = { preset: 'today', range: { from: today, to: today }, compare: 'previous',
    status: 'all', cashierId: null, registerId: null };
  it('labels cash and external payments Cash and Card', () => {
    const { figures } = salesRoomFigures([
      order(), order({ id: 'card', payments: [{ id: 'card', method: 'external', amountMinor: 1200 }] }),
    ], filters, 'EUR');
    expect(figures.totals).toMatchObject({ orderCount: 2, grossMinor: 2400 });
    expect(figures.payments.rows).toHaveLength(2);
    expect(figures.payments.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'cash', label: 'Cash', amountMinor: 1200, orders: 1 }),
      expect.objectContaining({ method: 'external', label: 'Card', amountMinor: 1200, orders: 1 }),
    ]));
  });
  it('totals today\'s in-currency orders of every sync status and counts the notes', () => {
    const summary = salesRoomFigures([
      order(),
      order({ id: 'pending', syncStatus: 'pending', totalMinor: 800, payments: [{ id: 'card', method: 'external', amountMinor: 800 }] }),
      order({ id: 'rejected', syncStatus: 'rejected', totalMinor: 500, payments: [{ id: 'cash', method: 'cash', amountMinor: 500 }] }),
      order({ id: 'usd', currency: 'USD', syncStatus: 'pending', totalMinor: 700 }),
    ], { ...filters, cashierId: 'ignored' }, 'eur');
    expect(summary.figures.totals).toMatchObject({ orderCount: 3, grossMinor: 2500 });
    expect(summary).toMatchObject({ notSentCount: 1, leftOutCount: 1 });
  });
  it.each([
    { status: 'pending', registerId: null, grossMinor: 1300, orderCount: 2, notSentCount: 2 },
    { status: 'all', registerId: 'register-1', grossMinor: 2000, orderCount: 2, notSentCount: 1 },
    { status: 'pending', registerId: 'register-1', grossMinor: 800, orderCount: 1, notSentCount: 1 },
  ])('restricts status=$status and register=$registerId', ({ status, registerId, grossMinor, orderCount, notSentCount }) => {
    const summary = salesRoomFigures([
      order({ registerId: 'register-1' }),
      order({ id: 'pending-1', registerId: 'register-1', syncStatus: 'pending', totalMinor: 800 }),
      order({ id: 'pending-2', registerId: 'register-2', syncStatus: 'pending', totalMinor: 500 }),
      order({ id: 'rejected', registerId: 'register-2', syncStatus: 'rejected', totalMinor: 400 }),
      order({ id: 'usd', registerId: 'register-2', currency: 'USD', totalMinor: 700 }),
    ], { ...filters, status, registerId }, 'EUR');
    expect(summary.figures.totals).toMatchObject({ grossMinor, orderCount });
    expect(summary).toMatchObject({ notSentCount, leftOutCount: 1 });
  });
  it('puts yesterday\'s orders in the comparison, outside today\'s totals and notes', () => {
    const createdAt = new Date(2026, 10, 9, 23, 30).toISOString();
    const summary = salesRoomFigures([
      order(), order({ id: 'yesterday', createdAt, syncStatus: 'pending', totalMinor: 800 }),
      order({ id: 'usd', createdAt, currency: 'USD' }),
    ], filters, 'EUR');
    expect(summary.figures.totals).toMatchObject({ orderCount: 1, grossMinor: 1200 });
    expect(summary.figures.comparison?.totals).toMatchObject({ orderCount: 1, grossMinor: 800 });
    expect(summary).toMatchObject({ notSentCount: 0, leftOutCount: 0 });
  });
  it('splits a split-tender order across its methods', () => {
    const { figures } = salesRoomFigures([order({ totalMinor: 2000, payments: [
      { id: 'cash', method: 'cash', amountMinor: 500 }, { id: 'card', method: 'external', amountMinor: 1500 },
    ] })], filters, 'EUR');
    expect(figures.totals).toMatchObject({ orderCount: 1, grossMinor: 2000 });
    expect(figures.payments.rows).toHaveLength(2);
    expect(figures.payments.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'cash', amountMinor: 500 }),
      expect.objectContaining({ method: 'external', amountMinor: 1500 }),
    ]));
  });
  it('is empty for a day with no orders', () => {
    expect(salesRoomFigures([], filters, 'EUR')).toMatchObject({ notSentCount: 0, leftOutCount: 0,
      figures: { totals: { orderCount: 0, grossMinor: 0 }, payments: { rows: [] } } });
  });
});

describe('closureScopeFor', () => {
  it('scopes today, the bound register and the store', () => {
    expect(closureScopeFor({ today, boundRegisterId: 'register-1', storeKey }))
      .toEqual({ from: today, to: today, registerId: 'register-1', storeKey });
  });
  it('an unbound till matches no register', () => {
    for (const boundRegisterId of [null, undefined]) {
      const scope = closureScopeFor({ today, boundRegisterId, storeKey });
      expect(scope.registerId).toBe('unbound');
      expect(selectClosureRows([closure()], scope, 'device')).toEqual([]);
    }
  });
  it('with selectClosureRows keeps today\'s closures of this register and store, newest first', () => {
    const rows = [
      closure({ id: 'A' }), closure({ id: 'B', closed_at: new Date(2026, 10, 10, 17).toISOString() }),
      closure({ id: 'C', register_id: 'register-2' }), closure({ id: 'D', business_day: '2026-11-09' }),
      closure({ id: 'E', store_key: 'https://other.test' }),
    ];
    expect(selectClosureRows(rows, closureScopeFor({ today, boundRegisterId: 'register-1', storeKey }), 'device').map((row) => row.id))
      .toEqual(['B', 'A']);
  });
});

describe('closureVarianceMinor', () => {
  it('sums every tender', () => {
    expect(closureVarianceMinor({ variance: { cash: -200, external: 50 } })).toBe(-150);
    expect(closureVarianceMinor({ variance: {} })).toBe(0);
  });
});

describe('csv', () => {
  it('exportCsv with csvLabel gives WCPOS\'s English header', () => {
    expect(exportCsv([closure()], 2, csvLabel).split('\r\n')[0]).toBe(
      '"Business day","Closure","Register","Store","Opened","Closed","Closer","Expected (cash)","Counted (cash)","Variance (cash)","Status"',
    );
  });
  it('csvLabel falls back to the key', () => {
    expect(csvLabel('reports.unknown')).toBe('reports.unknown');
  });
  it('closuresCsvFilename uses the scope days', () => {
    expect(closuresCsvFilename({ from: today, to: today })).toBe('closures-2026-11-10-2026-11-10.csv');
  });
  it('downloadCsv clicks a download link for a CSV blob and frees it', () => {
    URL.createObjectURL = vi.fn(() => 'blob:csv');
    URL.revokeObjectURL = vi.fn();
    let clicked!: HTMLAnchorElement;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked = this;
      expect(document.body.contains(this)).toBe(true);
      expect(this.hidden).toBe(true);
    });
    downloadCsv('closures-x.csv', 'a,b');
    expect(clicked.download).toBe('closures-x.csv');
    expect(clicked.href).toMatch(/blob:csv$/);
    const blob = vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob;
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('text/csv;charset=utf-8');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:csv');
    expect(document.body.querySelector('a')).toBeNull();
  });
});
