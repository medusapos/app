import type { buildClosureDocument } from '@tallyui/pos';

export type ClosureDocument = ReturnType<typeof buildClosureDocument>;
export const PRINT_FAILED = "Couldn't print the Z report. Try again.";
export const PRINT_FRAME_ID = 'closure-print-frame';
// Lets the frame lay out before the dialog.
const PRINT_SETTLE_MS = 50;
// Black on white, readable on 80 mm paper and as a centred column on A4.
const STYLE = `
@page { margin: 6mm }
body { margin: 0; font: 11pt/1.4 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; color: #000; background: #fff }
main { max-width: 80mm; margin: 0 auto }
h1 { font-size: 14pt } h2 { font-size: 12pt } h3 { font-size: 11pt; font-weight: bold }
table { width: 100%; border-collapse: collapse }
th { text-align: left; font-weight: normal }
td { text-align: right; font-variant-numeric: tabular-nums }
section { border-top: 1px solid #000; padding-top: 2mm }
.warning { font-weight: bold }
footer { font-size: 9pt }
`;

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function closureReportHtml(document: ClosureDocument): string {
  const { store, fiscal, register, closure: z, order } = document;
  const row = (label: unknown, value: unknown) => `<tr><th scope="row">${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`;
  const title = `Z report · Closure #${fiscal.receipt_number}`;
  const approver = z.approved_by ? String(z.breakdowns.labels.approved_by_name || z.approved_by) : null;
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body><main class="z-report">
  <header><h1>${escapeHtml(store.name)}</h1>${typeof store.address === 'string' && store.address ? `<p>${escapeHtml(store.address)}</p>` : ''}</header>
  <h2>${escapeHtml(title)}</h2>
  <table class="rows"><tbody>
    ${register.name ? row('Register', register.name) : ''}
    ${row('Opened', z.opened_at.datetime)}${row('Closed', z.closed_at.datetime)}
    ${z.breakdowns.labels.closed_by_name ? row('Closed by', z.breakdowns.labels.closed_by_name) : ''}
    ${row('Sales', z.period_sales_total_display)}${row('Opening float', z.breakdowns.opening_float.counted_display)}
  </tbody></table>
  ${z.tenders.map((tender) => `<section class="tender"><h3>${escapeHtml(tender.label)}</h3><table class="rows"><tbody>
    ${row('Expected', tender.expected_display)}${row('Counted', tender.counted_display)}
    ${row('Variance', tender.has_variance ? `${tender.variance_label} ${tender.variance_absolute_display}` : tender.variance_label)}
  </tbody></table></section>`).join('')}
  ${z.breakdowns.movements.length ? `<section class="movements"><h3>Paid in / out</h3><table class="rows"><tbody>
    ${z.breakdowns.movements.map((movement) => row(movement.type_label,
      `${movement.amount_display}${movement.reason ? ` · ${movement.reason}` : ''}${movement.voided ? ' · undone' : ''}`)).join('')}
  </tbody></table></section>` : ''}
  ${z.tax_rounding_note ? `<p class="note">${escapeHtml(z.tax_rounding_note)}</p>` : ''}
  ${z.unsynced_count > 0 ? `<p class="warning">${escapeHtml(`${z.unsynced_count} ${z.unsynced_count === 1 ? 'sale' : 'sales'} not sent yet · ${z.unsynced_total_display}`)}</p>` : ''}
  ${approver ? `<p class="approved">Approved by ${escapeHtml(approver)}</p>` : ''}
  <footer><p>Printed ${escapeHtml(order.printed.datetime)}</p></footer>
</main></body></html>`;
}

export async function printHtml(html: string): Promise<void> {
  if (typeof document === 'undefined') throw new Error(PRINT_FAILED);
  try {
    document.getElementById(PRINT_FRAME_ID)?.remove();
    const frame = document.createElement('iframe');
    frame.id = PRINT_FRAME_ID;
    frame.title = 'Z report';
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.style.cssText = 'position: fixed; right: 0; bottom: 0; width: 0; height: 0; border: 0';
    document.body.appendChild(frame);
    const doc = frame.contentDocument;
    if (!doc) throw new Error(PRINT_FAILED);
    doc.open();
    doc.write(html);
    doc.close();
    await new Promise<void>((resolve) => setTimeout(resolve, PRINT_SETTLE_MS));
    if (!frame.contentWindow) throw new Error(PRINT_FAILED);
    frame.contentWindow.focus();
    frame.contentWindow.print();
  } catch (error) {
    console.warn('Could not print the Z report:', error);
    throw new Error(PRINT_FAILED);
  }
}
