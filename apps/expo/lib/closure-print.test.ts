// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildClosureDocument, buildXReportDocument, formatClosureDate, TAX_ROUNDING_MIXED_NOTE, type Closure, type ClosureContext, type RegisterSession } from '@tallyui/pos';
import { closureReportHtml, printHtml, printXReport, xReportHtml, PRINT_FAILED, PRINT_FRAME_ID, X_PRINT_FAILED } from './closure-print';

function row(overrides: Partial<Closure> = {}): Closure {
  return {
    id: 'closure-fixture', session_id: 'session-fixture', register_id: 'register-fixture', store_key: '1',
    business_day: '2026-09-11', closed_by: '1', corrections_count: 0, number: 42,
    opened_at: '2026-09-11T08:00:00Z', closed_at: '2026-09-11T17:00:00Z',
    till_expected: { cash: 18000, card: 12000 }, expected: { cash: 18000, card: 12000 },
    counted: { cash: 17800, card: 12000 }, variance: { cash: -200, card: 0 },
    period_sales_total_minor: 25000, period_refunds_total_minor: 5000,
    perpetual_sales_total_minor: 525000, perpetual_refunds_total_minor: 25000,
    unsynced_count: 2, unsynced_total_minor: 1200, software_version: 'preview',
    breakdowns: {
      currency: 'EUR', transaction_count: 12, refund_count: 2, cashiers: [{ id: '1', name: 'Alex' }],
      register_name: 'Main register', opened_by: '1', opened_by_name: 'Alex', closed_by_name: 'Alex',
      approved_by: '1', approved_by_name: 'Alex',
      payment_methods: { cash: { sales_minor: 13000, refunds_minor: 5000 }, card: { sales_minor: 12000, refunds_minor: 0 } },
      tax_rates: { vat: { name: 'VAT 20%', net_minor: 16667, tax_minor: 3333, gross_minor: 20000 } },
      opening_float: { expected_minor: 10000, counted_minor: 10000, variance_minor: 0 },
      movements: [{ id: 'm1', type: 'paid_out', amountMinor: 500, reason: 'Petty cash',
        created_at_gmt: '2026-09-11T10:00:00Z', created_by: '1', voids: null, voided_by: 'v1' }],
    },
    order_ids: [], movement_ids: [], server_closure_id: null, printed_at: null, print_count: 0, number_retried: false,
    ...overrides,
  };
}
const context: ClosureContext = {
  currency: 'EUR', exponent: 2, timezone: 'UTC', locale: 'en-GB',
  store: { name: 'Test shop', address: '1 High Street' }, printedAt: '2026-09-11T17:05:00Z',
  i18n: { over: 'Over', short: 'Short', exact: 'Exact', paid_in: 'Paid in', paid_out: 'Paid out', no_sale: 'No sale', void: 'Void' },
  formatMoney: (v) => `€${v}`,
};
const makeDocument = (overrides: Partial<Closure> = {}, ctx = context) => buildClosureDocument(row(overrides), ctx);
const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');
const breakdowns = row().breakdowns;

describe('closureReportHtml', () => {
  const row = (scope: ParentNode, label: string) => Array.from(scope.querySelectorAll('tr'))
    .find((tr) => tr.querySelector('th')?.textContent === label)?.querySelector('td')?.textContent;

  it('prints the store, the closure number, the register and the session totals', () => {
    const page = parse(closureReportHtml(makeDocument()));
    expect(page.querySelector('h1')?.textContent).toBe('Test shop');
    expect(page.querySelector('header p')?.textContent).toBe('1 High Street');
    expect(page.querySelector('h2')?.textContent).toBe('Z report · Closure #42');
    expect(page.title).toBe('Z report · Closure #42');
    const totals = page.querySelector('main > table.rows')!;
    expect(row(totals, 'Register')).toBe('Main register');
    expect(row(totals, 'Opened')).toBe(formatClosureDate('2026-09-11T08:00:00Z', context).datetime);
    expect(row(totals, 'Closed')).toBe(formatClosureDate('2026-09-11T17:00:00Z', context).datetime);
    expect(row(totals, 'Closed by')).toBe('Alex');
    expect(row(totals, 'Sales')).toBe('€250.00');
    expect(row(totals, 'Opening float')).toBe('€100.00');
    expect(page.querySelector('footer')?.textContent).toBe(`Printed ${formatClosureDate(context.printedAt, context).datetime}`);
  });

  it("prints each tender's expected, counted and variance", () => {
    const page = parse(closureReportHtml(makeDocument()));
    const tenders = Array.from(page.querySelectorAll('section.tender'));
    expect(tenders).toHaveLength(2);
    expect(tenders.map((tender) => tender.querySelector('h3')?.textContent)).toEqual(['Cash', 'Card']);
    expect(row(tenders[0], 'Expected')).toBe('€180.00');
    expect(row(tenders[0], 'Counted')).toBe('€178.00');
    expect(row(tenders[0], 'Variance')).toBe('Short €2.00');
    expect(row(tenders[1], 'Expected')).toBe('€120.00');
    expect(row(tenders[1], 'Counted')).toBe('€120.00');
    expect(row(tenders[1], 'Variance')).toBe('Exact');
  });

  it('prints paid in / out, the unsynced warning and the approver', () => {
    const page = parse(closureReportHtml(makeDocument()));
    expect(page.querySelector('section.movements h3')?.textContent).toBe('Paid in / out');
    expect(row(page.querySelector('section.movements')!, 'Paid out')).toBe('€5.00 · Petty cash · undone');
    expect(page.querySelector('p.warning')?.textContent).toBe('2 sales not sent yet · €12.00');
    expect(page.querySelector('p.approved')?.textContent).toBe('Approved by Alex');
  });

  it('says "1 sale" for a single unsynced sale', () => {
    const page = parse(closureReportHtml(makeDocument({ unsynced_count: 1, unsynced_total_minor: 500 })));
    expect(page.querySelector('p.warning')?.textContent).toBe('1 sale not sent yet · €5.00');
  });

  it('leaves out what the closure does not have', () => {
    const minimal = { payment_methods: breakdowns.payment_methods, opening_float: breakdowns.opening_float };
    const page = parse(closureReportHtml(makeDocument({ breakdowns: minimal, unsynced_count: 0 }, { ...context, store: { name: 'Test shop' } })));
    expect(page.querySelector('header p')).toBeNull();
    expect(row(page, 'Register')).toBeUndefined();
    expect(row(page, 'Closed by')).toBeUndefined();
    expect(page.querySelector('section.movements')).toBeNull();
    expect(page.querySelector('p.warning')).toBeNull();
    expect(page.querySelector('p.approved')).toBeNull();
    expect(page.querySelector('p.note')).toBeNull();
  });

  it('prints the tax rounding note when the sales mixed roundings', () => {
    const page = parse(closureReportHtml(makeDocument({ breakdowns: { ...breakdowns, tax_rounding_mixed: true } })));
    expect(page.querySelector('p.note')?.textContent).toBe(TAX_ROUNDING_MIXED_NOTE);
  });

  it('escapes every value it prints', () => {
    const name = '<img src=x onerror=alert(1)>';
    const address = 'A & B "Ltd"';
    const reason = "<script>alert(1)</script>'";
    const movements = [{ id: 'm1', type: 'paid_out', amountMinor: 500, reason, created_at_gmt: '2026-09-11T10:00:00Z', voided_by: 'v1' }];
    const html = closureReportHtml(makeDocument({ breakdowns: { ...breakdowns, movements } }, { ...context, store: { name, address } }));
    const page = parse(html);
    expect(page.querySelector('img')).toBeNull();
    expect(page.querySelector('script')).toBeNull();
    expect(page.querySelector('h1')?.textContent).toBe(name);
    expect(page.querySelector('header p')?.textContent).toBe(address);
    expect(row(page.querySelector('section.movements')!, 'Paid out')).toBe(`€5.00 · ${reason} · undone`);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
  });

  it('is a whole page with print styles and no script', () => {
    const html = closureReportHtml(makeDocument());
    const page = parse(html);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(page.querySelectorAll('style')).toHaveLength(1);
    expect(page.querySelector('style')?.textContent).toContain('@page');
    expect(page.querySelector('script')).toBeNull();
  });
});

function session(overrides: Partial<RegisterSession> = {}): RegisterSession {
  return {
    id: 's1', register_id: 'register-1', store_key: 'https://shop.test', status: 'open',
    opened_at_gmt: '2026-09-11T08:00:00Z', expected_float_minor: 10000,
    counted_float_minor: 10000, opening_variance_minor: 0, ...overrides,
  };
}

describe('xReportHtml', () => {
  const xContext = { ...context, expected: { cash: 18000, card: 12000 }, breakdowns: { register_name: 'Main register' } };
  const row = (scope: ParentNode, label: string) => Array.from(scope.querySelectorAll('tr'))
    .find((tr) => tr.querySelector('th')?.textContent === label)?.querySelector('td')?.textContent;

  it('prints the store, the register, the opened time, sales so far and the float', () => {
    const page = parse(xReportHtml(buildXReportDocument(session(), xContext), 3));
    expect(page.querySelector('h1')?.textContent).toBe('Test shop');
    expect(page.querySelector('h2')?.textContent).toBe('X report');
    expect(page.title).toBe('X report');
    expect(page.querySelector('p.note')?.textContent).toBe('Not a closure. The register stays open.');
    expect(row(page, 'Register')).toBe('Main register');
    expect(row(page, 'Opened')).toBe(formatClosureDate('2026-09-11T08:00:00Z', { timezone: 'UTC', locale: 'en-GB' }).datetime);
    expect(row(page, 'Sales')).toBe('3 sales');
    expect(row(page, 'Opening float')).toBe('€100.00');
    expect(page.querySelector('main.x-report')).not.toBeNull();
  });

  it('prints expected per tender and no count, variance or closure number', () => {
    const html = xReportHtml(buildXReportDocument(session(), xContext), 3);
    const page = parse(html);
    const tenders = Array.from(page.querySelectorAll('section.tender'));
    expect(tenders).toHaveLength(2);
    expect(tenders.map((tender) => tender.querySelector('h3')?.textContent)).toEqual(['Cash', 'Card']);
    expect(row(tenders[0], 'Expected')).toBe('€180.00');
    expect(row(tenders[1], 'Expected')).toBe('€120.00');
    for (const label of ['Counted', 'Variance', 'Closed']) expect(row(page, label)).toBeUndefined();
    expect(html).not.toContain('Closure #');
  });

  it('says "1 sale" and leaves out an empty register name', () => {
    const page = parse(xReportHtml(buildXReportDocument(session(), { ...xContext, breakdowns: { register_name: '' } }), 1));
    expect(row(page, 'Sales')).toBe('1 sale');
    expect(row(page, 'Register')).toBeUndefined();
  });

  it('escapes the values it prints', () => {
    const name = '<img src=x onerror=alert(1)>';
    const html = xReportHtml(buildXReportDocument(session(), {
      ...xContext, store: { name }, breakdowns: { register_name: '<script>x</script>' },
    }), 3);
    const page = parse(html);
    expect(page.querySelector('img')).toBeNull();
    expect(page.querySelector('script')).toBeNull();
    expect(page.querySelector('h1')?.textContent).toBe(name);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
  });
});

describe('printHtml', () => {
  afterEach(() => {
    document.getElementById(PRINT_FRAME_ID)?.remove();
    vi.restoreAllMocks();
  });

  it('writes the page into a hidden frame and prints that frame, not the app', async () => {
    const appPrint = vi.spyOn(window, 'print').mockImplementation(() => {});
    const done = printHtml('<!doctype html><html><body><p>Z</p></body></html>');
    const frame = document.getElementById(PRINT_FRAME_ID) as HTMLIFrameElement;
    expect(frame.getAttribute('aria-hidden')).toBe('true');
    const print = vi.spyOn(frame.contentWindow!, 'print').mockImplementation(() => {});
    await done;
    expect(print).toHaveBeenCalledOnce();
    expect(appPrint).not.toHaveBeenCalled();
    expect(frame.contentDocument!.body.textContent).toBe('Z');
  });

  it('a second print replaces the frame', async () => {
    let previous: HTMLIFrameElement | null = null;
    for (const text of ['First', 'Second']) {
      const done = printHtml(`<!doctype html><html><body><p>${text}</p></body></html>`);
      const frame = document.getElementById(PRINT_FRAME_ID) as HTMLIFrameElement;
      expect(frame).not.toBe(previous);
      const print = vi.spyOn(frame.contentWindow!, 'print').mockImplementation(() => {});
      await done;
      expect(print).toHaveBeenCalledOnce();
      expect(document.querySelectorAll(`#${PRINT_FRAME_ID}`)).toHaveLength(1);
      expect(frame.contentDocument!.body.textContent).toBe(text);
      previous = frame;
    }
  });

  it("rejects with the app's message when the browser's print throws", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const done = printHtml('<!doctype html><html><body>Z</body></html>');
    const frame = document.getElementById(PRINT_FRAME_ID) as HTMLIFrameElement;
    vi.spyOn(frame.contentWindow!, 'print').mockImplementation(() => { throw new Error('boom'); });
    await expect(done).rejects.toThrow(PRINT_FAILED);
  });

  it('prints the X report with its own title and failure message', async () => {
    const input = { session: session(), expected: { cash: 500 }, salesCount: 0, registerName: 'Main register', context };
    const done = printXReport(input);
    const frame = document.getElementById(PRINT_FRAME_ID) as HTMLIFrameElement;
    expect(frame.title).toBe('X report');
    const print = vi.spyOn(frame.contentWindow!, 'print').mockImplementation(() => {});
    await done;
    expect(print).toHaveBeenCalledOnce();
    expect(frame.contentDocument!.querySelector('h2')?.textContent).toBe('X report');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failed = printXReport(input);
    const secondFrame = document.getElementById(PRINT_FRAME_ID) as HTMLIFrameElement;
    vi.spyOn(secondFrame.contentWindow!, 'print').mockImplementation(() => { throw new Error('boom'); });
    await expect(failed).rejects.toThrow(X_PRINT_FAILED);
  });
});
