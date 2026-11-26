import { orderReference, type SalesCardId } from '@tallyui/components';
import { csvFromCells, formatClosureDate, minorToDecimal, type ClosureContext, type GroupRow, type PosOrder, type SalesFigures } from '@tallyui/pos';
import { closureDayLabel, localDay, paymentMethodLabel } from './reports';

export type ReportColumn = { label: string; align: 'left' | 'right' };
export type ReportPanel = {
  card: SalesCardId;
  title: string;
  columns: ReportColumn[];
  rows: string[][];
  more: number;
  status: string;
  filename: string;
  /** What the sheet says when the panel has no rows; the sheet's own "None in this period" when absent. */
  empty?: string;
};

// v2's Orders panel lists the 60 most recent orders of the period.
const ORDERS_LISTED = 60;
// A figure the till does not know reads as a dash, never 0 (as TallyUI's cards show it).
const UNKNOWN = '—';

const left = (label: string): ReportColumn => ({ label, align: 'left' });
const right = (label: string): ReportColumn => ({ label, align: 'right' });

export function reportPanel(card: SalesCardId, input: {
  figures: SalesFigures; orders: readonly PosOrder[];
  ctx: Pick<ClosureContext, 'formatMoney' | 'exponent' | 'locale'>; today: string;
  /** The store's refunds could not be read, so an empty Refunds panel must not claim there were none. */
  refundsUnread?: boolean;
}): ReportPanel {
  const { figures, orders, ctx, today } = input;
  const { totals, range } = figures;
  const money = (minor: number) => ctx.formatMoney(minorToDecimal(minor, ctx.exponent));
  // Medusa keeps no cost of goods by default: without a costed line the cost columns would only ever read a dash.
  const costed = totals.margin.costedNetMinor > 0;
  const costColumns = costed ? [right('Cost'), right('Profit'), right('Margin %')] : [];
  const costCells = (row: GroupRow) => !costed ? [] : row.margin.costedNetMinor === 0 ? [UNKNOWN, UNKNOWN, UNKNOWN] : [
    money(row.margin.costMinor), money(row.margin.profitMinor),
    row.margin.marginPct === null ? UNKNOWN : `${(row.margin.marginPct * 100).toFixed(1)}%`,
  ];
  const group = (row: GroupRow, name: string) => [name, String(row.quantity), money(row.netMinor), ...costCells(row)];
  let status = `${totals.orderCount} ${totals.orderCount === 1 ? 'order' : 'orders'} · ${money(totals.grossMinor)}`;
  const costStatus = () => {
    if (costed && totals.margin.missingQuantity > 0) status += ` · cost missing on ${totals.margin.missingQuantity} of ${totals.items} items`;
  };
  const panel = (title: string, slug: string, columns: ReportColumn[], rows: string[][], more = 0): ReportPanel =>
    ({ card, title, columns, rows, more, status, filename: `${slug}-${range.from}-${range.to}.csv` });

  switch (card) {
    case 'orders': {
      const listed = orders.slice(0, ORDERS_LISTED);
      const more = orders.length - listed.length;
      if (more > 0) status += ` · ${more} more`;
      return panel('Orders', 'orders', [left('Order'), left('Time'), left('Payment'), right('Total')], listed.map((order) => {
        const at = new Date(order.createdAt);
        const time = at.toLocaleTimeString(ctx.locale, { hour: '2-digit', minute: '2-digit' });
        const methods = [...new Set(order.payments.map((p) => paymentMethodLabel(p.method)))];
        return [orderReference(order), range.from !== range.to ? `${closureDayLabel(localDay(at), today, ctx.locale)} ${time}` : time,
          methods.length ? methods.join(' + ') : UNKNOWN, money(order.totalMinor)];
      }), more);
    }
    case 'payments':
      return panel('Sales by payment method', 'payment-methods', [left('Method'), right('Orders'), right('Amount')],
        figures.payments.rows.map((row) => [
          row.label || (row.method === 'unpaid' ? 'Unpaid' : row.method === 'unknown' ? 'Unknown' : paymentMethodLabel(row.method)),
          String(row.orders), money(row.amountMinor),
        ]));
    case 'products':
      costStatus();
      return panel('Top products', 'top-products', [left('Product'), right('Qty'), right('Amount'), ...costColumns],
        figures.products.map((row) => group(row, row.name)));
    case 'categories':
      costStatus();
      return panel('Sales by category', 'categories', [left('Category'), right('Qty'), right('Amount'), ...costColumns],
        figures.categories.map((row) => group(row, row.key === '' ? 'Uncategorised' : row.name)));
    case 'taxes':
      return panel('Taxes collected', 'taxes', [left('Rate'), right('Net'), right('Tax'), right('Gross')],
        figures.taxes.map((row) => [row.label || 'Tax', row.netMinor === null ? UNKNOWN : money(row.netMinor),
          money(row.taxMinor), row.netMinor === null ? UNKNOWN : money(row.netMinor + row.taxMinor)]));
    case 'refunds': {
      const refunds = panel('Refunds', 'refunds', [left('Refunds'), right('Orders'), right('Amount')],
        figures.refunds.count > 0 ? [['Refunds', String(figures.refunds.count), money(figures.refunds.amountMinor)]] : []);
      return refunds.rows.length === 0 && input.refundsUnread ? { ...refunds, empty: "Refunds couldn't be read from the store." } : refunds;
    }
  }
}

export function reportPanelCsv(panel: ReportPanel): string {
  return csvFromCells([panel.columns.map((column) => column.label), ...panel.rows]);
}

// Black on white, readable on 80 mm paper and as a centred column on A4 (as the till's other printed reports).
const STYLE = `
@page { margin: 6mm }
body { margin: 0; font: 11pt/1.4 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; color: #000; background: #fff }
main { max-width: 80mm; margin: 0 auto }
h1 { font-size: 14pt } h2 { font-size: 12pt }
table { width: 100%; border-collapse: collapse }
th { font-weight: normal; border-bottom: 1px solid #000 }
th, td { text-align: left; vertical-align: top }
.right { text-align: right; font-variant-numeric: tabular-nums }
footer { font-size: 9pt }
`;

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function reportPanelHtml(panel: ReportPanel, input: {
  ctx: Pick<ClosureContext, 'store' | 'formatMoney' | 'exponent' | 'timezone' | 'locale' | 'printedAt'>;
  covers: string;
}): string {
  const { ctx, covers } = input;
  const { store } = ctx;
  const align = (index: number) => panel.columns[index]?.align === 'right' ? ' class="right"' : '';
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(panel.title)}</title><style>${STYLE}</style></head>
<body><main class="report-panel">
  <header><h1>${escapeHtml(store.name)}</h1>${typeof store.address === 'string' && store.address ? `<p>${escapeHtml(store.address)}</p>` : ''}</header>
  <h2>${escapeHtml(panel.title)}</h2>
  <p class="covers">${escapeHtml(covers)}</p>
  <table class="report">
    <thead><tr>${panel.columns.map((column, i) => `<th scope="col"${align(i)}>${escapeHtml(column.label)}</th>`).join('')}</tr></thead>
    <tbody>${panel.rows.map((row) => `<tr>${row.map((cell, i) => `<td${align(i)}>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody>
  </table>
  <p class="status">${escapeHtml(panel.status)}</p>
  <footer><p>Printed ${escapeHtml(formatClosureDate(ctx.printedAt, ctx).datetime)}</p></footer>
</main></body></html>`;
}
