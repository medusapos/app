// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { GroupRow, Margin, PosOrder, SalesFigures } from '@tallyui/pos';
import { reportPanel, reportPanelCsv, reportPanelHtml } from './report-panels';
import { closureDayLabel } from './reports';

const today = '2026-11-18';
const ctx = { formatMoney: (value: string) => `€${value}`, exponent: 2, locale: 'en-GB' };
const noCost: Margin = { costedNetMinor: 0, costMinor: 0, profitMinor: 0, marginPct: null, missingLines: 0, missingQuantity: 0 };
function figures(overrides: Partial<SalesFigures> = {}, margin: Margin = noCost): SalesFigures {
  return {
    range: { from: today, to: today },
    totals: { grossMinor: 1200, netMinor: 1200, taxMinor: 0, discountMinor: 0, refundsMinor: 0, embeddedRefundsMinor: 0, roundingMinor: 0, refundBasis: 'embedded',
      grossAfterRefundsMinor: 1200,
      orderCount: 2, averageMinor: 600, items: 5, margin },
    payments: { rows: [], takenMinor: 0 }, products: [], categories: [], taxes: [],
    refunds: { count: 0, amountMinor: 0, orders: 0 }, series: [], ...overrides,
  };
}
const row = (key: string, name: string, quantity: number, netMinor: number, margin: Margin = noCost): GroupRow =>
  ({ key, name, quantity, netMinor, margin });
const panel = (card: Parameters<typeof reportPanel>[0], f: SalesFigures, orders: PosOrder[] = []) =>
  reportPanel(card, { figures: f, orders, ctx, today });

describe('reportPanel', () => {
  it('lists Top products without cost columns when no line has a cost', () => {
    const result = panel('products', figures({ products: [row('shirt', 'Shirt', 2, 800), row('hat', 'Hat', 1, 400)] }));
    expect(result.title).toBe('Top products');
    expect(result.columns.map((column) => column.label)).toEqual(['Product', 'Qty', 'Amount']);
    expect(result.columns.map((column) => column.align)).toEqual(['left', 'right', 'right']);
    expect(result.rows).toEqual([['Shirt', '2', '€8.00'], ['Hat', '1', '€4.00']]);
    expect(result.status).toBe('2 orders · €12.00');
    expect(result.more).toBe(0);
    expect(result.filename).toBe('top-products-2026-11-18-2026-11-18.csv');
  });

  it('adds Cost, Profit and Margin % once a line has a cost, with dashes on an uncosted row', () => {
    const costed: Margin = { costedNetMinor: 800, costMinor: 500, profitMinor: 300, marginPct: 0.375, missingLines: 0, missingQuantity: 0 };
    const total: Margin = { ...costed, missingLines: 1, missingQuantity: 3 };
    const result = panel('products', figures({ products: [row('shirt', 'Shirt', 2, 800, costed), row('hat', 'Hat', 3, 400)] }, total));
    expect(result.columns.map((column) => column.label)).toEqual(['Product', 'Qty', 'Amount', 'Cost', 'Profit', 'Margin %']);
    expect(result.rows[0]).toEqual(['Shirt', '2', '€8.00', '€5.00', '€3.00', '37.5%']);
    expect(result.rows[1]).toEqual(['Hat', '3', '€4.00', '—', '—', '—']);
    expect(result.status).toBe('2 orders · €12.00 · cost missing on 3 of 5 items');
  });

  it('reads a category with no key as Uncategorised', () => {
    const result = panel('categories', figures({ categories: [row('', '', 1, 400), row('tops', 'Tops', 2, 800)] }));
    expect(result.title).toBe('Sales by category');
    expect(result.rows.map((cells) => cells[0])).toEqual(['Uncategorised', 'Tops']);
    expect(result.filename).toBe('categories-2026-11-18-2026-11-18.csv');
  });

  it('names an unlabelled unpaid payment row Unpaid', () => {
    const result = panel('payments', figures({ payments: { takenMinor: 800, rows: [
      { method: 'cash', label: 'Cash', amountMinor: 800, orders: 1 }, { method: 'unpaid', label: '', amountMinor: 400, orders: 1 },
    ] } }));
    expect(result.title).toBe('Sales by payment method');
    expect(result.columns.map((column) => column.label)).toEqual(['Method', 'Orders', 'Amount']);
    expect(result.rows).toEqual([['Cash', '1', '€8.00'], ['Unpaid', '1', '€4.00']]);
    expect(result.filename).toBe('payment-methods-2026-11-18-2026-11-18.csv');
  });

  it('shows dashes for an unknown tax net and gross, and net + tax when the net is known', () => {
    const result = panel('taxes', figures({ taxes: [
      { key: 'a', ratePpm: 230000, label: 'VAT 23%', taxMinor: 230, netMinor: 1000 },
      { key: 'b', ratePpm: 0, label: '', taxMinor: 50, netMinor: null },
    ] }));
    expect(result.columns.map((column) => column.label)).toEqual(['Rate', 'Net', 'Tax', 'Gross']);
    expect(result.rows).toEqual([['VAT 23%', '€10.00', '€2.30', '€12.30'], ['Tax', '—', '€0.50', '—']]);
  });

  it('lists refunds as one row only when there are any', () => {
    expect(panel('refunds', figures()).rows).toEqual([]);
    const result = panel('refunds', figures({ refunds: { count: 2, amountMinor: 700, orders: 2 } }));
    expect(result.rows).toEqual([['Refunds', '2', '€7.00']]);
    expect(result.empty).toBeUndefined();
  });
  it('the refunds panel says the refunds could not be read when the read failed', () => {
    const unread = reportPanel('refunds', { figures: figures(), orders: [], ctx, today, refundsUnread: true });
    expect(unread).toMatchObject({ rows: [], empty: "Refunds couldn't be read from the store." });
    expect(panel('refunds', figures()).empty).toBeUndefined();
    // Refunds that were counted still show; another card's empty text is never changed.
    const counted = reportPanel('refunds', { figures: figures({ refunds: { count: 1, amountMinor: 300, orders: 1 } }), orders: [],
      ctx, today, refundsUnread: true });
    expect(counted.rows).toEqual([['Refunds', '1', '€3.00']]);
    expect(counted.empty).toBeUndefined();
    expect(reportPanel('products', { figures: figures(), orders: [], ctx, today, refundsUnread: true }).empty).toBeUndefined();
  });

  it('lists the 60 most recent orders in the given order and counts the rest', () => {
    const at = new Date(2026, 10, 18, 9, 5);
    const orders = Array.from({ length: 61 }, (_, i) => ({
      id: `order-${String(i).padStart(8, '0')}`, createdAt: at.toISOString(), totalMinor: 100 * (i + 1),
      payments: i === 0 ? [{ method: 'cash' }, { method: 'external' }, { method: 'cash' }] : i === 1 ? [] : [{ method: 'cash' }],
    }) as unknown as PosOrder);
    const result = panel('orders', figures(), orders);
    const time = at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    expect(result.columns.map((column) => column.label)).toEqual(['Order', 'Time', 'Payment', 'Total']);
    expect(result.rows).toHaveLength(60);
    expect(result.more).toBe(1);
    expect(result.status).toBe('2 orders · €12.00 · 1 more');
    expect(result.rows[0]).toEqual(['00000000', time, 'Cash + Card', '€1.00']);
    expect(result.rows[1][2]).toBe('—');
    expect(result.rows[59][0]).toBe('00000059');
    const week = panel('orders', figures({ range: { from: '2026-11-16', to: today } }), orders.slice(0, 1));
    expect(week.rows[0][1]).toBe(`${closureDayLabel('2026-11-18', today, 'en-GB')} ${time}`);
    expect(week.rows[0][1]).toBe(`Today ${time}`);
  });
});

describe('reportPanelCsv and reportPanelHtml', () => {
  const products = panel('products', figures({ products: [row('x', '<b>x</b>', 1, 400), row('hat', 'Hat', 2, 800)] }));
  it('starts the CSV with the column labels', () => {
    const lines = reportPanelCsv(products).split('\r\n');
    // csvFromCells quotes every cell.
    expect(lines[0]).toBe('"Product","Qty","Amount"');
    expect(lines).toContain('"<b>x</b>","1","€4.00"');
  });
  it('prints the title, what it covers and one table row per report row, escaped', () => {
    const html = reportPanelHtml(products, {
      ctx: { ...ctx, store: { name: 'Test shop' }, timezone: 'device', printedAt: '2026-11-18T10:00:00Z' },
      covers: 'Today · All registers',
    });
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<h2>Top products</h2>');
    expect(html).toContain('Today · All registers');
    const body = html.slice(html.indexOf('<tbody>'), html.indexOf('</tbody>'));
    expect(body.match(/<tr>/g)).toHaveLength(2);
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('Printed ');
  });

  const htmlInput = {
    ctx: { ...ctx, store: { name: 'Test shop' }, timezone: 'device' as const, printedAt: '2026-11-18T10:00:00Z' },
    covers: 'Today · All registers',
  };
  const page = (html: string) => new DOMParser().parseFromString(html, 'text/html');
  it('an unread Refunds panel prints and exports the couldn\'t-be-read note, not an empty table', () => {
    const unread = reportPanel('refunds', { figures: figures(), orders: [], ctx, today, refundsUnread: true });
    const html = reportPanelHtml(unread, htmlInput);
    expect(page(html).querySelector('p.warning')?.textContent).toBe("Refunds couldn't be read from the store.");
    expect(html).toContain('Refunds couldn&#39;t be read from the store.');
    expect(Array.from(page(html).querySelectorAll('thead th')).map((th) => th.textContent)).toEqual(['Refunds', 'Orders', 'Amount']);
    expect(page(html).querySelectorAll('tbody tr')).toHaveLength(0);
    expect(reportPanelCsv(unread).split('\r\n')).toEqual(['"Refunds","Orders","Amount"', '"Refunds couldn\'t be read from the store."']);
  });
  it('a panel without an empty note prints and exports as before', () => {
    const none = panel('refunds', figures());
    expect(none.empty).toBeUndefined();
    const html = reportPanelHtml(none, htmlInput);
    expect(html).toContain('<tbody></tbody>');
    expect(page(html).querySelector('p.warning')).toBeNull();
    expect(reportPanelCsv(none)).toBe('"Refunds","Orders","Amount"');
    // A note never replaces rows that are there.
    const listed = { ...products, empty: 'None read' };
    expect(reportPanelHtml(listed, htmlInput)).toBe(reportPanelHtml(products, htmlInput));
    expect(reportPanelCsv(listed)).toBe(reportPanelCsv(products));
  });
});
