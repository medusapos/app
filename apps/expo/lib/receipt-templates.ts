import {
  createPrintQueue, createSystemPrintTransport, RECEIPT_SCHEMA_VERSION, renderReceiptHtml, SYSTEM_PRINTER_ID,
  type PrintTransport, type ReceiptData, type ReceiptPaper,
} from '@tallyui/pos';

export type ReceiptTemplateId = 'standard' | 'thermal-80mm' | 'thermal-58mm';

// v2's Settings › Printing "Receipt templates". Standard is the receipt the paid screen and Orders print today; the
// thermal two are TallyUI's DEFAULT_RECEIPT_TEMPLATES, rendered by renderReceiptHtml for their paper.
export const RECEIPT_TEMPLATES: readonly { id: ReceiptTemplateId; name: string; tag: string; paper?: ReceiptPaper }[] = [
  { id: 'standard', name: 'Standard Receipt', tag: 'Sales' },
  { id: 'thermal-80mm', name: 'Thermal Receipt (80mm)', tag: 'Thermal 80mm', paper: '80mm' },
  { id: 'thermal-58mm', name: 'Thermal Receipt (58mm)', tag: 'Thermal 58mm', paper: '58mm' },
];

// A fixed sale for previews and test prints: two lines, paid in cash with change, no tax.
export function sampleReceipt(store: { name: string; address?: string; currency: string }, now: Date = new Date()): ReceiptData {
  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    software: { name: '', plugin_version: '', app_version: '', app_build: '', platform: '' },
    register: { id: '', name: '' },
    fiscal: { document_type: 'sale', is_reprint: false, reprint_count: 0, qr_payload: '' },
    header: { storeName: store.name, storeAddress: store.address, orderNumber: 'Sample', date: now.toISOString() },
    lineItems: [
      { name: 'Sample item', sku: '', quantity: 2, unitPriceMinor: 500, lineTotalMinor: 1000, displayAmountMinor: 1000, displayDiscounts: [] },
      { name: 'Another item', sku: '', quantity: 1, unitPriceMinor: 750, lineTotalMinor: 750, displayAmountMinor: 750, displayDiscounts: [] },
    ],
    fees: [],
    shipping: [],
    discounts: [],
    orderDiscountMinor: 0,
    totals: { taxInclusive: false, subtotalMinor: 1750, discountMinor: 0, taxLines: [], taxMinor: 0, totalMinor: 1750 },
    payments: [{ method: 'cash', amountMinor: 2000 }],
    changeDueMinor: 250,
    footer: {},
    currency: store.currency,
  };
}

// A whole page around TallyUI's rendered (sanitized) receipt fragment, for a preview frame or the print dialog.
export function receiptTemplatePage(paper: ReceiptPaper, receipt: ReceiptData): string {
  return '<!doctype html><html><head><meta charset="utf-8"><title>Receipt</title><style>body { margin: 0 }</style></head>'
    + `<body>${renderReceiptHtml(receipt, { paper })}</body></html>`;
}

// One queue for the print dialog, as v2 keeps one per printer. A job's own transport (a test's fake) is looked up by
// its id; otherwise it goes to TallyUI's system print transport, created on first use.
const jobTransports = new Map<string, PrintTransport>();
let systemTransport: PrintTransport | undefined;
const queue = createPrintQueue({
  transportFor: () => ({
    name: 'receipt-templates',
    print: (job) => (jobTransports.get(job.id) ?? (systemTransport ??= createSystemPrintTransport())).print(job),
  }),
});
let jobCount = 0;

export function printReceiptPage(html: string, transport?: PrintTransport): Promise<void> {
  const id = `receipt-template-test-${++jobCount}`;
  if (transport) jobTransports.set(id, transport);
  return queue.print(SYSTEM_PRINTER_ID, { id, kind: 'test', html }).finally(() => jobTransports.delete(id));
}

// A finished sale's thermal receipt, from the paid screen: the same print dialog queue, as a receipt job.
export function printSalePage(html: string, transport?: PrintTransport): Promise<void> {
  const id = `receipt-sale-${++jobCount}`;
  if (transport) jobTransports.set(id, transport);
  return queue.print(SYSTEM_PRINTER_ID, { id, kind: 'receipt', html }).finally(() => jobTransports.delete(id));
}
