// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addRxPlugin, createRxDatabase, randomToken, type RxCollection, type RxDatabase } from 'rxdb';
import { RxDBDevModePlugin } from 'rxdb/plugins/dev-mode';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import { wrappedValidateAjvStorage } from 'rxdb/plugins/validate-ajv';
import { orderReference } from '@tallyui/components';
import { PortalHost } from '@tallyui/primitives';
import { formatMoney } from '@tallyui/core';
import { addPrinterProfileCollection, createOrderBuilder, finalizeOrder, SYSTEM_PRINTER_ID, type PosOrder } from '@tallyui/pos';
import { useOutboxOrders } from '../lib/outbox-context';
import { BUILT_IN_PRINTER } from '../lib/printers';
import { saveSession } from '../lib/session';
import { SessionProvider } from '../lib/session-context';
import { saveCachedSettings, type StoreSettings } from '../lib/store-settings';
import { OrderDetailSheet } from '../components/order-detail-sheet';
import { loadReceiptPrinter, loadReceiptTemplate, printSalePage, saveReceiptPrinter, saveReceiptTemplate } from '../lib/receipt-templates';

vi.mock('../lib/outbox-context', async (original) => ({
  ...await original<typeof import('../lib/outbox-context')>(), useOutboxOrders: vi.fn(() => null),
}));

vi.mock('../lib/receipt-templates', async (original) => ({
  ...await original<typeof import('../lib/receipt-templates')>(), printSalePage: vi.fn(),
}));

const settings: StoreSettings = {
  storeName: 'Default Store', currency: 'EUR',
  location: { id: 'loc_1', name: 'European Warehouse', addressLine: 'Street 1, Copenhagen', countryCode: 'dk' },
};
const PRINT_STYLE_ID = 'order-receipt-print-style';

beforeEach(() => {
  vi.mocked(printSalePage).mockClear();
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  });
  saveSession(localStorage, { baseUrl: 'https://store.test', email: 'admin@store.test', token: 'token' });
  saveCachedSettings(localStorage, 'https://store.test', settings);
  // The stylesheet lives in document.head, which cleanup() leaves alone.
  document.getElementById(PRINT_STYLE_ID)?.remove();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('order detail Receipt (row 10.3)', () => {
  function sale(): PosOrder {
    const builder = createOrderBuilder({ currency: 'EUR', taxContext: { pricesIncludeTax: false, getTaxRatePpm: () => 0 } });
    builder.addLine({ productId: 'shirt', variantId: 'blue', name: 'Blue shirt', unitPrice: { amount: 1200, currency: 'EUR' } });
    builder.addPayment({ method: 'cash', amountMinor: 1200 });
    return { ...finalizeOrder(builder.getSnapshot()), syncStatus: 'applied' };
  }
  const formatDate = (iso: string) => iso.slice(0, 10);
  // The app's root layout holds the PortalHost the sheet renders into.
  function sheet(order: PosOrder | null) {
    return <SessionProvider><OrderDetailSheet order={order} onClose={vi.fn()} formatDate={formatDate} onRetry={vi.fn()}
      onFlush={vi.fn()} /><PortalHost /></SessionProvider>;
  }

  it('with no saved template the reprint is the Standard receipt and shows the Template and Printer pickers on web', async () => {
    const order = sale();
    render(sheet(order));
    fireEvent.click(await screen.findByTestId('order-detail-receipt'));
    expect(screen.getByTestId('receipt-order').textContent).toBe(`Order ${orderReference(order)}`);
    expect(screen.getByTestId('receipt-template-select').textContent).toContain('Standard Receipt');
    expect(screen.getByTestId('receipt-printer-select').textContent).toBe('Auto — Print dialog');
    expect(screen.queryByTestId('receipt-thermal-frame')).toBeNull();
  });

  it('with Thermal 80mm saved, the reprint shows the 80mm page of this sale and prints it through the queue', async () => {
    saveReceiptTemplate(localStorage, 'https://store.test', 'thermal-80mm');
    const print = vi.spyOn(window, 'print').mockImplementation(() => {});
    const order = sale();
    render(sheet(order));
    fireEvent.click(await screen.findByTestId('order-detail-receipt'));
    const page = screen.getByTestId('receipt-thermal-frame').getAttribute('srcdoc');
    expect(page).toContain('width: 48ch');
    expect(page).toContain(orderReference(order));
    expect(page).not.toContain(order.id);
    expect(page).toContain('Blue shirt');
    expect(page).toContain(settings.storeName);
    expect(page).toContain(settings.location.addressLine);
    expect(page).toContain('Copy 1');
    expect(page).not.toContain('Cashier');
    fireEvent.click(screen.getByTestId('paid-print'));
    expect(printSalePage).toHaveBeenCalledOnce();
    expect(printSalePage).toHaveBeenCalledWith(page);
    expect(print).not.toHaveBeenCalled();
  });

  it("a synced sale's thermal reprint prints the same order reference as its other receipts", async () => {
    saveReceiptTemplate(localStorage, 'https://store.test', 'thermal-80mm');
    const order = { ...sale(), serverRefs: { orderId: 'server-order', displayId: '1042', totalMinor: 1200 } };
    render(sheet(order));
    fireEvent.click(await screen.findByTestId('order-detail-receipt'));
    expect(screen.getByTestId('receipt-thermal-frame').getAttribute('srcdoc')).toContain(orderReference(order));
  });

  it('Back on a thermal reprint returns to the order detail', async () => {
    saveReceiptTemplate(localStorage, 'https://store.test', 'thermal-80mm');
    render(sheet(sale()));
    fireEvent.click(await screen.findByTestId('order-detail-receipt'));
    const back = screen.getByTestId('paid-new-sale');
    expect(back.textContent).toBe('Back');
    fireEvent.click(back);
    expect(await screen.findByTestId('order-detail-receipt')).toBeTruthy();
  });

  it("choosing 58mm in the reprint's picker shows the 58mm page and saves the choice", async () => {
    render(sheet(sale()));
    fireEvent.click(await screen.findByTestId('order-detail-receipt'));
    fireEvent.click(screen.getByTestId('receipt-template-select'));
    fireEvent.click(await screen.findByTestId('receipt-template-option-thermal-58mm'));
    expect(screen.getByTestId('receipt-thermal-frame').getAttribute('srcdoc')).toContain('width: 32ch');
    expect(loadReceiptTemplate(localStorage, 'https://store.test')).toBe('thermal-58mm');
  });

  it('Receipt swaps the detail for TallyUI\'s receipt of the sale, with the cached store name', async () => {
    const order = sale();
    render(sheet(order));
    const detail = within(await screen.findByTestId('order-detail-sheet'));
    expect(detail.getByTestId('order-detail-close').textContent).toBe('Close');
    fireEvent.click(detail.getByTestId('order-detail-receipt'));
    const receipt = within(await screen.findByTestId('order-detail-receipt-view'));
    expect(receipt.getByTestId('receipt-order').textContent).toBe(`Order ${orderReference(order)}`);
    expect(receipt.getByText('Default Store')).toBeTruthy();
    expect(receipt.getByText('Blue shirt')).toBeTruthy();
    expect(receipt.getByLabelText(`Total: ${formatMoney({ amount: order.totalMinor, currency: 'EUR' })}`)).toBeTruthy();
    expect(screen.queryByTestId('order-detail-receipt')).toBeNull();
  });

  it('Print receipt on the reprint calls window.print once', async () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => {});
    render(sheet(sale()));
    fireEvent.click(await screen.findByTestId('order-detail-receipt'));
    fireEvent.click(within(await screen.findByTestId('order-detail-receipt-view')).getByRole('button', { name: 'Print receipt' }));
    expect(print).toHaveBeenCalledTimes(1);
  });

  it('Back returns to the order detail', async () => {
    render(sheet(sale()));
    fireEvent.click(await screen.findByTestId('order-detail-receipt'));
    fireEvent.click(within(await screen.findByTestId('order-detail-receipt-view')).getByRole('button', { name: 'Back' }));
    expect(await screen.findByTestId('order-detail-receipt')).toBeTruthy();
    expect(screen.queryByTestId('order-detail-receipt-view')).toBeNull();
  });

  it('re-opening the sheet after a close starts on the order detail', async () => {
    const order = sale();
    const { rerender } = render(sheet(order));
    fireEvent.click(await screen.findByTestId('order-detail-receipt'));
    expect(await screen.findByTestId('order-detail-receipt-view')).toBeTruthy();
    rerender(sheet(null));
    expect(screen.queryByTestId('order-detail-sheet')).toBeNull();
    rerender(sheet(order));
    expect(await screen.findByTestId('order-detail-receipt')).toBeTruthy();
    expect(screen.queryByTestId('order-detail-receipt-view')).toBeNull();
  });

  it('on web, the reprint adds its print-only stylesheet', async () => {
    render(sheet(sale()));
    await screen.findByTestId('order-detail-receipt');
    expect(document.getElementById(PRINT_STYLE_ID)).toBeNull();
    fireEvent.click(screen.getByTestId('order-detail-receipt'));
    await screen.findByTestId('order-detail-receipt-view');
    expect(document.getElementById(PRINT_STYLE_ID)?.textContent).toContain('@media print');
  });

  describe('the Orders reprint to a network printer', () => {
    let db: RxDatabase;
    beforeEach(async () => {
      addRxPlugin(RxDBDevModePlugin);
      db = await createRxDatabase({ name: `reprint${randomToken(8)}`, storage: wrappedValidateAjvStorage({ storage: getRxStorageMemory() }) });
      const printers = await addPrinterProfileCollection(db);
      await printers.insert(BUILT_IN_PRINTER);
      await printers.insert({ id: 'counter', name: 'Counter', connectionType: 'network', vendor: 'epson',
        address: '10.0.0.5', port: 9100, language: 'esc-pos', autoOpenDrawer: true });
      vi.mocked(useOutboxOrders).mockReturnValue({ database: db } as unknown as RxCollection<PosOrder>);
    });
    afterEach(async () => { vi.mocked(useOutboxOrders).mockReturnValue(null); await db.close(); });

    it('a thermal reprint goes to the chosen network printer without opening the drawer', async () => {
      saveReceiptTemplate(localStorage, 'https://store.test', 'thermal-80mm');
      saveReceiptPrinter(localStorage, 'https://store.test', 'thermal-80mm', 'counter');
      const requests = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, status: 200, text: async () => '<response success="true"/>' }));
      vi.stubGlobal('fetch', requests);
      const dialog = vi.spyOn(window, 'print').mockImplementation(() => {});
      const order = sale();
      render(sheet(order));
      fireEvent.click(await screen.findByTestId('order-detail-receipt'));
      await waitFor(() => expect(screen.getByTestId('receipt-printer-select').textContent).toBe('Counter'));
      fireEvent.click(screen.getByTestId('paid-print'));
      const epos = await waitFor(() => {
        const calls = requests.mock.calls.filter(([url]) => String(url).includes('/epos/'));
        expect(calls.map(([url]) => url)).toEqual(['http://10.0.0.5:8008/cgi-bin/epos/service.cgi?devid=local_printer&timeout=10000']);
        return calls;
      });
      const hex = String(epos[0]![1]?.body).match(/<command>([0-9a-f]+)<\/command>/)?.[1]!;
      const text = Buffer.from(hex, 'hex').toString('latin1');
      expect(text).toContain('Blue shirt');
      expect(text).toContain(orderReference(order));
      expect(text).not.toContain(order.id);
      expect(hex).not.toContain('101401');
      expect(hex).not.toContain('1b70');
      expect(printSalePage).not.toHaveBeenCalled();
      expect(dialog).not.toHaveBeenCalled();
    });

    it('prints a 58mm reprint at 32 columns on the saved network printer', async () => {
      saveReceiptTemplate(localStorage, 'https://store.test', 'thermal-58mm');
      saveReceiptPrinter(localStorage, 'https://store.test', 'thermal-58mm', 'counter');
      const requests = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, status: 200, text: async () => '<response success="true"/>' }));
      vi.stubGlobal('fetch', requests);
      render(sheet(sale()));
      fireEvent.click(await screen.findByTestId('order-detail-receipt'));
      await waitFor(() => expect(screen.getByTestId('receipt-printer-select').textContent).toBe('Counter'));
      requests.mockClear();
      fireEvent.click(screen.getByTestId('paid-print'));
      await waitFor(() => expect(requests).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('/epos/'), expect.anything()));
      const hex = String(requests.mock.calls[0]![1]?.body).match(/<command>([0-9a-f]+)<\/command>/)?.[1]!;
      expect(Buffer.from(hex, 'hex').toString('latin1').split('\n')).toContain('-'.repeat(32));
    });

    it("the reprint's Printer select lists Counter for 80mm and saves the choice", async () => {
      saveReceiptTemplate(localStorage, 'https://store.test', 'thermal-80mm');
      render(sheet(sale()));
      fireEvent.click(await screen.findByTestId('order-detail-receipt'));
      fireEvent.click(screen.getByTestId('receipt-printer-select'));
      await screen.findByTestId('receipt-printer-option-counter');
      expect(screen.getAllByTestId(/^receipt-printer-option-/).map((option) => option.textContent)).toEqual(['Auto — Print dialog', 'Counter']);
      fireEvent.click(screen.getByTestId('receipt-printer-option-counter'));
      expect(loadReceiptPrinter(localStorage, 'https://store.test', 'thermal-80mm')).toBe('counter');
      expect(loadReceiptPrinter(localStorage, 'https://store.test', 'thermal-58mm')).toBe(SYSTEM_PRINTER_ID);
      expect(screen.getByTestId('receipt-printer-select').textContent).toBe('Counter');
    });

    it('a reprint whose saved printer was deleted prints the page through the print dialog', async () => {
      saveReceiptTemplate(localStorage, 'https://store.test', 'thermal-80mm');
      saveReceiptPrinter(localStorage, 'https://store.test', 'thermal-80mm', 'gone');
      const requests = vi.fn(async (_url: string) => ({ ok: true, status: 200, text: async () => '<response success="true"/>' }));
      vi.stubGlobal('fetch', requests);
      render(sheet(sale()));
      fireEvent.click(await screen.findByTestId('order-detail-receipt'));
      fireEvent.click(screen.getByTestId('receipt-printer-select'));
      await screen.findByTestId('receipt-printer-option-counter');
      const page = screen.getByTestId('receipt-thermal-frame').getAttribute('srcdoc');
      fireEvent.click(screen.getByTestId('paid-print'));
      expect(printSalePage).toHaveBeenCalledTimes(1);
      expect(printSalePage).toHaveBeenCalledWith(page);
      expect(requests.mock.calls.filter(([url]) => String(url).includes('/epos/'))).toHaveLength(0);
      expect(screen.getByTestId('receipt-printer-select').textContent).toBe('Auto — Print dialog');
    });

    it('a failed network reprint says it could not print and opens no print dialog', async () => {
      saveReceiptTemplate(localStorage, 'https://store.test', 'thermal-80mm');
      saveReceiptPrinter(localStorage, 'https://store.test', 'thermal-80mm', 'counter');
      vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
      const dialog = vi.spyOn(window, 'print').mockImplementation(() => {});
      render(sheet(sale()));
      fireEvent.click(await screen.findByTestId('order-detail-receipt'));
      await waitFor(() => expect(screen.getByTestId('receipt-printer-select').textContent).toBe('Counter'));
      vi.mocked(fetch).mockClear();
      fireEvent.click(screen.getByTestId('paid-print'));
      expect((await screen.findByTestId('paid-print-status')).textContent).toBe("Couldn't print. Try again.");
      expect(fetch).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('/epos/'), expect.anything());
      expect(printSalePage).not.toHaveBeenCalled();
      expect(dialog).not.toHaveBeenCalled();
    });
  });
});
