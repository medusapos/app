// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SalesFilters } from '@tallyui/components';
import { createOrderBuilder, exportCsv, finalizeOrder, selectClosureRows, type Closure, type PosOrder } from '@tallyui/pos';
import { byCashier, closureCashierOptions, closureDayLabel, closureDays, closureHistoryWindow, closureDayTotal, closureScopeFor, closuresCsvFilename, closureTableRow, closureVarianceMinor, csvLabel, downloadCsv, historyClosure, historyTableRow, localDay, localDayStartIso, paymentMethodLabel, salesRoomFigures, showsTodayClosures, varianceLabel } from './reports';
import { closureContext } from '../components/register-close';
import type { ClosureHistoryEntry } from './closure-history';

vi.mock('expo-localization', () => ({ getLocales: () => [{ languageTag: 'en-GB' }] }));

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

describe('closureTableRow', () => {
  it('uses breakdown names and sums counted and variance across tenders', () => {
    const row = closure({ breakdowns: { register_name: 'Front till', closed_by_name: 'Ana' },
      counted: { cash: 800, external: 500 }, variance: { cash: -200, external: 50 } });
    expect(closureTableRow(row, { 'register-1': 'Register 1' })).toEqual({
      id: row.id, number: row.number, day: today, openedAt: row.opened_at, closedAt: row.closed_at, registerName: 'Front till', cashierName: 'Ana',
      salesMinor: 1000, countedMinor: 1300, varianceMinor: -150,
    });
  });
  it('uses the map or id slice and an unknown cashier when breakdown names are empty', () => {
    expect(closureTableRow(closure(), { 'register-1': 'Register 1' }))
      .toMatchObject({ registerName: 'Register 1', cashierName: '—' });
    expect(closureTableRow(closure({ breakdowns: { register_name: '', closed_by_name: '' } }), {}))
      .toMatchObject({ registerName: 'register', cashierName: '—' });
  });
  it('falls back to the local day of the closed time when the business day is absent', () => {
    const row = closure({ business_day: undefined, closed_at: new Date(2026, 10, 8, 23, 30).toISOString() });
    expect(closureTableRow(row, {}).day).toBe('2026-11-08');
    expect(closureTableRow({ ...row, business_day: '' }, {}).day).toBe('2026-11-08');
  });
});

describe('historyTableRow', () => {
  const entry = { closureId: 'c1', number: 1, openedAt: '2026-11-09T09:00:00Z', closedAt: '2026-11-09T18:00:00Z',
    periodSalesTotalMinor: 1000, registerId: 'register-1', closedBy: 'user-1' };
  it('calculates counted and variance and resolves the cashier name', () => {
    expect(historyTableRow({ ...entry, counted: { cash: 800 }, tillExpected: { cash: 1000 } }, 'Register 1', { 'user-1': 'Ana' }))
      .toEqual({ id: 'c1', number: 1, day: localDay(new Date(entry.closedAt)), openedAt: entry.openedAt, closedAt: entry.closedAt, registerName: 'Register 1', cashierName: 'Ana',
        salesMinor: 1000, countedMinor: 800, varianceMinor: -200 });
  });
  it('keeps unknown figures null and falls back to cashier id or a dash', () => {
    expect(historyTableRow(entry, 'Register 1', {})).toMatchObject({ countedMinor: null, varianceMinor: null, cashierName: 'user-1' });
    expect(historyTableRow({ ...entry, closedBy: undefined, counted: { cash: 800 } }, 'Register 1', {}))
      .toMatchObject({ countedMinor: 800, varianceMinor: null, cashierName: '—' });
  });
  it('uses the register id slice or a dash when the register name is empty', () => {
    expect(historyTableRow(entry, '', {}).registerName).toBe('register');
    expect(historyTableRow({ ...entry, registerId: undefined }, '', {}).registerName).toBe('—');
  });
  it('uses the business day, else the local day of the closed time', () => {
    expect(historyTableRow({ ...entry, businessDay: '2026-11-07' }, '', {}).day).toBe('2026-11-07');
    const closedAt = new Date(2026, 10, 8, 23, 30).toISOString();
    expect(historyTableRow({ ...entry, closedAt }, '', {}).day).toBe('2026-11-08');
  });
});

describe('closureDays', () => {
  const row = (id: string, day: string, countedMinor: number | null, varianceMinor: number | null) => ({
    id, number: 1, day, openedAt: '', closedAt: '', registerName: '', cashierName: '', salesMinor: 0, countedMinor, varianceMinor });
  it('groups by day in order of first appearance and sums counted and variance', () => {
    const [a, b, c] = [row('a', '2026-11-10', 800, -200), row('b', '2026-11-09', 500, 0), row('c', '2026-11-10', 1000, 50)];
    expect(closureDays([a, b, c])).toEqual([
      { day: '2026-11-10', rows: [a, c], countedMinor: 1800, varianceMinor: -150 },
      { day: '2026-11-09', rows: [b], countedMinor: 500, varianceMinor: 0 },
    ]);
  });
  it('keeps nulls when every row is unknown and sums only known figures', () => {
    expect(closureDays([row('a', 'd', null, null), row('b', 'd', null, null)])[0]).toMatchObject({ countedMinor: null, varianceMinor: null });
    expect(closureDays([row('a', 'd', null, null), row('b', 'd', 700, null), row('c', 'd', 300, -100)])[0])
      .toMatchObject({ countedMinor: 1000, varianceMinor: -100 });
  });
});

describe('closureDayLabel', () => {
  it('names today and yesterday and formats earlier days', () => {
    expect(closureDayLabel(today, today, 'en-GB')).toBe('Today');
    expect(closureDayLabel('2026-11-09', today, 'en-GB')).toBe('Yesterday');
    expect(closureDayLabel('2026-11-08', today, 'en-GB')).toBe(new Intl.DateTimeFormat('en-GB',
      { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date('2026-11-08T00:00:00Z')));
  });
});

describe('closureDayTotal', () => {
  const ctx = closureContext('EUR', { name: 'X' });
  it('reads counted and variance for the day', () => {
    expect(closureDayTotal({ countedMinor: null, varianceMinor: null }, ctx)).toBe('');
    expect(closureDayTotal({ countedMinor: 1800, varianceMinor: null }, ctx)).toBe(`${ctx.formatMoney('18.00')} counted`);
    expect(closureDayTotal({ countedMinor: 1800, varianceMinor: 0 }, ctx)).toBe(`${ctx.formatMoney('18.00')} counted · Exact`);
    expect(closureDayTotal({ countedMinor: 1800, varianceMinor: -200 }, ctx))
      .toBe(`${ctx.formatMoney('18.00')} counted · ${ctx.formatMoney('2.00')} short`);
  });
});

describe('historyClosure', () => {
  const entry: ClosureHistoryEntry = { closureId: 'c12', number: 12, businessDay: '2026-11-09', openedAt: '2026-11-09T09:00:00Z',
    closedAt: '2026-11-09T18:00:00Z', periodSalesTotalMinor: 4500, registerId: 'register-1', counted: { cash: 4400 }, tillExpected: { cash: 4500 } };
  it('opens the device\'s own closure by id or server closure id', () => {
    const own = closure({ id: 'c12' });
    expect(historyClosure(entry, [closure(), own])).toEqual({ closure: own, frozen: true });
    const synced = closure({ id: 'local', server_closure_id: 'c12' });
    expect(historyClosure(entry, [synced])).toEqual({ closure: synced, frozen: true });
  });
  it('builds a closure from the store figures', () => {
    expect(historyClosure(entry, [closure()])).toEqual({ frozen: false, closure: {
      id: 'c12', session_id: '', register_id: 'register-1', business_day: '2026-11-09', number: 12,
      opened_at: entry.openedAt, closed_at: entry.closedAt, till_expected: { cash: 4500 }, expected: { cash: 4500 },
      counted: { cash: 4400 }, variance: { cash: -100 }, period_sales_total_minor: 4500, period_refunds_total_minor: 0,
      perpetual_sales_total_minor: 0, perpetual_refunds_total_minor: 0, unsynced_count: 0, unsynced_total_minor: 0,
      software_version: '', breakdowns: {}, order_ids: [], movement_ids: [], print_count: 0,
    } });
  });
  it('opens nothing without counted or till-expected figures', () => {
    expect(historyClosure({ ...entry, counted: undefined }, [])).toBeNull();
    expect(historyClosure({ ...entry, tillExpected: undefined }, [])).toBeNull();
  });
});

describe('varianceLabel', () => {
  it('labels exact, short and over amounts', () => {
    const ctx = closureContext('EUR', { name: 'X' });
    expect(varianceLabel(0, ctx)).toBe('Exact');
    expect(varianceLabel(-200, ctx)).toBe(`${ctx.formatMoney('2.00')} short`);
    expect(varianceLabel(50, ctx)).toBe(`${ctx.formatMoney('0.50')} over`);
  });
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

describe('salesRoomFigures periodOrders', () => {
  const filters: SalesFilters = { preset: 'today', range: { from: today, to: today }, compare: 'previous',
    status: 'all', cashierId: null, registerId: null };
  const at = (day: number, hour: number) => new Date(2026, 10, day, hour, 0).toISOString();
  it('lists the period\'s orders newest first', () => {
    const { periodOrders } = salesRoomFigures([
      order({ id: 'noon', createdAt: at(10, 12) }), order({ id: 'evening', createdAt: at(10, 18) }),
      order({ id: 'morning', createdAt: at(10, 9) }),
    ], filters, 'EUR');
    expect(periodOrders.map((row) => row.id)).toEqual(['evening', 'noon', 'morning']);
  });
  it('leaves out an order from an earlier day', () => {
    const { periodOrders } = salesRoomFigures([
      order({ id: 'earlier', createdAt: at(9, 12) }), order({ id: 'today', createdAt: at(10, 12) }),
    ], filters, 'EUR');
    expect(periodOrders.map((row) => row.id)).toEqual(['today']);
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

describe('closure filters', () => {
  it('closureHistoryWindow clips the own register to yesterday and keeps another register\'s days', () => {
    expect(closureHistoryWindow({ from: '2026-11-03', to: '2026-11-10' }, today, true)).toEqual({ from: '2026-11-03', to: '2026-11-09' });
    expect(closureHistoryWindow({ from: '2026-11-03', to: '2026-11-08' }, today, true)).toEqual({ from: '2026-11-03', to: '2026-11-08' });
    expect(closureHistoryWindow({ from: '2026-11-03', to: '2026-11-10' }, today, false)).toEqual({ from: '2026-11-03', to: '2026-11-10' });
    expect(closureHistoryWindow({ from: today, to: today }, today, true)).toBeNull();
    expect(closureHistoryWindow({ from: today, to: today }, today, false)).toEqual({ from: today, to: today });
  });
  it('showsTodayClosures only for the own register when the range holds today', () => {
    expect(showsTodayClosures({ from: today, to: today }, today, true)).toBe(true);
    expect(showsTodayClosures({ from: '2026-11-03', to: '2026-11-10' }, today, true)).toBe(true);
    expect(showsTodayClosures({ from: '2026-11-09', to: '2026-11-09' }, today, true)).toBe(false);
    expect(showsTodayClosures({ from: today, to: today }, today, false)).toBe(false);
  });
  it('byCashier keeps every row for null and the cashier\'s rows otherwise', () => {
    const rows = [{ id: 'a', by: 'user-1' }, { id: 'b', by: 'user-2' }, { id: 'c', by: null }];
    expect(byCashier(rows, null, (row) => row.by)).toEqual(rows);
    expect(byCashier(rows, 'user-2', (row) => row.by)).toEqual([{ id: 'b', by: 'user-2' }]);
  });
  it('closureCashierOptions dedupes, falls back to the id and sorts by label', () => {
    expect(closureCashierOptions(['user-2', 'user-1', 'user-2', 'user-9'], { 'user-1': 'Zoe', 'user-2': 'Ana' })).toEqual([
      { value: 'user-2', label: 'Ana' }, { value: 'user-9', label: 'user-9' }, { value: 'user-1', label: 'Zoe' },
    ]);
  });
});
