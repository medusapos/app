// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportCsv, selectClosureRows, type Closure, type PosOrder } from '@tallyui/pos';
import { closureScopeFor, closuresCsvFilename, closureVarianceMinor, csvLabel, downloadCsv, localDay, localDayStartIso, summarizeSales } from './reports';

const today = '2026-11-10';
const storeKey = 'https://store.test';
function order(overrides: Partial<PosOrder> = {}): PosOrder {
  return { id: 'order', createdAt: new Date(2026, 10, 10, 12, 0).toISOString(), currency: 'EUR', totalMinor: 1200,
    payments: [{ id: 'cash', method: 'cash', amountMinor: 1200 }], syncStatus: 'applied', ...overrides } as PosOrder;
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

describe('summarizeSales', () => {
  it('counts today\'s orders of every sync status and totals them', () => {
    const summary = summarizeSales([
      order(),
      order({ id: 'pending', syncStatus: 'pending', totalMinor: 800, payments: [{ id: 'card', method: 'external', amountMinor: 800 }] }),
      order({ id: 'rejected', syncStatus: 'rejected', totalMinor: 500, payments: [{ id: 'cash', method: 'cash', amountMinor: 500 }] }),
      order({ id: 'yesterday', createdAt: new Date(2026, 10, 9, 23, 30).toISOString() }),
    ], today, 'EUR');
    expect(summary).toEqual({ count: 3, grossMinor: 2500, notSentCount: 1, leftOutCount: 0, methods: [
      { method: 'cash', label: 'Cash', amountMinor: 1700 }, { method: 'external', label: 'Card', amountMinor: 800 },
    ] });
  });
  it('splits a split-tender order across its methods', () => {
    const summary = summarizeSales([order({ totalMinor: 2000, payments: [
      { id: 'cash', method: 'cash', amountMinor: 500 }, { id: 'card', method: 'external', amountMinor: 1500 },
    ] })], today, 'EUR');
    expect(summary).toMatchObject({ count: 1, grossMinor: 2000, methods: [
      { method: 'cash', label: 'Cash', amountMinor: 500 }, { method: 'external', label: 'Card', amountMinor: 1500 },
    ] });
  });
  it('leaves out orders in another currency', () => {
    const summary = summarizeSales([
      order({ totalMinor: 1000, payments: [{ id: 'cash', method: 'cash', amountMinor: 1000 }] }),
      order({ id: 'usd', currency: 'USD', syncStatus: 'pending', totalMinor: 700, payments: [{ id: 'card', method: 'external', amountMinor: 700 }] }),
    ], today, 'eur');
    expect(summary).toEqual({ count: 1, grossMinor: 1000, leftOutCount: 1, notSentCount: 0,
      methods: [{ method: 'cash', label: 'Cash', amountMinor: 1000 }] });
  });
  it('orders methods cash, external, then others alphabetically', () => {
    const payments = ['voucher', 'external', 'cash', 'account'].map((method) => ({ id: method, method, amountMinor: 100 }));
    const summary = summarizeSales([order({ totalMinor: 400, payments: payments as PosOrder['payments'] })], today, 'EUR');
    expect(summary.methods.map((entry) => entry.method)).toEqual(['cash', 'external', 'account', 'voucher']);
    expect(summary.methods[3].label).toBe('Voucher');
  });
  it('is empty for a day with no orders', () => {
    expect(summarizeSales([], today, 'EUR')).toEqual({ count: 0, grossMinor: 0, methods: [], notSentCount: 0, leftOutCount: 0 });
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
