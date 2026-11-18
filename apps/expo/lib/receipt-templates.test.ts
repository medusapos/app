// @vitest-environment jsdom
import { formatMoney } from '@tallyui/core';
import { renderReceiptHtml, SYSTEM_PRINT_TIMING, type PrintJob, type PrintTransport } from '@tallyui/pos';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { printReceiptPage, RECEIPT_TEMPLATES, receiptTemplatePage, sampleReceipt } from './receipt-templates';

const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');
const store = { name: 'Test shop', address: '1 High Street', currency: 'EUR' };

describe('RECEIPT_TEMPLATES', () => {
  it("lists Standard, then TallyUI's two thermal templates", () => {
    expect(RECEIPT_TEMPLATES).toEqual([
      { id: 'standard', name: 'Standard Receipt', tag: 'Sales' },
      { id: 'thermal-80mm', name: 'Thermal Receipt (80mm)', tag: 'Thermal 80mm', paper: '80mm' },
      { id: 'thermal-58mm', name: 'Thermal Receipt (58mm)', tag: 'Thermal 58mm', paper: '58mm' },
    ]);
  });
});

describe('receiptTemplatePage', () => {
  it("is a whole page around TallyUI's rendered sample sale, with no script", () => {
    const receipt = sampleReceipt(store);
    const page = parse(receiptTemplatePage('80mm', receipt));
    expect(page.querySelector('script')).toBeNull();
    expect(page.title).toBe('Receipt');
    const text = page.body.textContent ?? '';
    for (const expected of ['Test shop', '1 High Street', 'Sample item', 'Another item', 'Thank you']) {
      expect(text).toContain(expected);
    }
    expect(text).toContain(formatMoney({ amount: 1750, currency: 'EUR' }));
    expect(page.body.innerHTML).toBe(renderReceiptHtml(receipt, { paper: '80mm' }));
  });

  it('lays the 58mm paper out narrower than the 80mm', () => {
    const receipt = sampleReceipt(store);
    const narrow = receiptTemplatePage('58mm', receipt);
    const wide = receiptTemplatePage('80mm', receipt);
    expect(narrow).not.toBe(wide);
    expect(parse(narrow).body.firstElementChild?.getAttribute('style')).toContain('width: 32ch');
    expect(parse(wide).body.firstElementChild?.getAttribute('style')).toContain('width: 48ch');
  });
});

describe('printReceiptPage', () => {
  afterEach(() => {
    document.getElementById('tallyui-print-frame')?.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('prints each page as a test job, in call order, through the given transport', async () => {
    const jobs: PrintJob[] = [];
    const fake: PrintTransport = { name: 'fake', print: async (job) => { jobs.push(job); } };
    await Promise.all([printReceiptPage('<p>one</p>', fake), printReceiptPage('<p>two</p>', fake)]);
    expect(jobs.map(({ kind, html }) => ({ kind, html }))).toEqual([
      { kind: 'test', html: '<p>one</p>' },
      { kind: 'test', html: '<p>two</p>' },
    ]);
    expect(jobs[0]!.id).not.toBe(jobs[1]!.id);
  });

  it('rejects when the transport fails, and the next print still goes through', async () => {
    const failing: PrintTransport = { name: 'failing', print: async () => { throw new Error('jammed'); } };
    await expect(printReceiptPage('<p>one</p>', failing)).rejects.toThrow('jammed');
    const jobs: PrintJob[] = [];
    await printReceiptPage('<p>two</p>', { name: 'fake', print: async (job) => { jobs.push(job); } });
    expect(jobs.map(({ html }) => html)).toEqual(['<p>two</p>']);
  });

  it("with no transport, prints in TallyUI's hidden frame through the print dialog, not the app's page", async () => {
    vi.useFakeTimers();
    const appPrint = vi.spyOn(window, 'print').mockImplementation(() => {});
    const done = printReceiptPage(receiptTemplatePage('80mm', sampleReceipt({ name: 'Frame shop', currency: 'USD' })));
    // The queue hands the job to the transport a few microtasks later; the frame is written then.
    await vi.advanceTimersByTimeAsync(0);
    const frame = document.getElementById('tallyui-print-frame') as HTMLIFrameElement;
    expect(frame).toBeTruthy();
    const framePrint = vi.spyOn(frame.contentWindow!, 'print').mockImplementation(() => {});
    // jsdom has no window focus(); the transport focuses the frame before printing.
    vi.spyOn(frame.contentWindow!, 'focus').mockImplementation(() => {});
    await vi.advanceTimersByTimeAsync(SYSTEM_PRINT_TIMING.renderDelayMs);
    expect(document.getElementById('tallyui-print-frame')).toBe(frame);
    expect(frame.contentDocument!.body.textContent).toContain('Frame shop');
    expect(framePrint).toHaveBeenCalledOnce();
    expect(appPrint).not.toHaveBeenCalled();
    const win = frame.contentWindow as Window & typeof globalThis;
    win.dispatchEvent(new win.Event('afterprint'));
    await expect(done).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(SYSTEM_PRINT_TIMING.removeDelayMs);
  });
});
