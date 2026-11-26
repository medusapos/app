// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PortalHost } from '@tallyui/primitives';
import { orderReference } from '@tallyui/components';
import { createOrderBuilder, finalizeOrder, type PosOrder, type PrinterProfile } from '@tallyui/pos';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReceiptPickers, ThermalPaidReceipt } from '../components/receipt-pickers';
import { BUILT_IN_PRINTER } from '../lib/printers';
import { printSalePage } from '../lib/receipt-templates';

// The print dialog, observed; the rest of the module (templates, page) stays real.
vi.mock('../lib/receipt-templates', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/receipt-templates')>(),
  printSalePage: vi.fn(),
}));

afterEach(cleanup);

describe('ReceiptPickers', () => {
  const network: PrinterProfile = { id: 'kitchen', name: 'Kitchen printer', connectionType: 'network', address: '10.0.0.9' };
  const mount = (onTemplateChange = vi.fn()) => {
    render(<><ReceiptPickers templateId="standard" onTemplateChange={onTemplateChange} printers={[BUILT_IN_PRINTER, network]} /><PortalHost /></>);
    return onTemplateChange;
  };

  it('shows Template on Standard Receipt and Printer on the print dialog', () => {
    mount();
    expect(screen.getByText('Template')).toBeTruthy();
    expect(screen.getByTestId('receipt-template-select').textContent).toBe('Standard Receipt');
    expect(screen.getByText('Printer')).toBeTruthy();
    expect(screen.getByTestId('receipt-printer-select').textContent).toBe('Auto — Print dialog');
  });

  it('lists the three templates and picks the 80mm one', () => {
    const onTemplateChange = mount();
    fireEvent.click(screen.getByTestId('receipt-template-select'));
    expect(screen.getAllByTestId(/^receipt-template-option-/).map((item) => item.textContent))
      .toEqual(['Standard Receipt', 'Thermal Receipt (80mm)', 'Thermal Receipt (58mm)']);
    fireEvent.click(screen.getByTestId('receipt-template-option-thermal-80mm'));
    expect(onTemplateChange).toHaveBeenCalledWith('thermal-80mm');
  });

  it('lists only the printers that can print', () => {
    mount();
    fireEvent.click(screen.getByTestId('receipt-printer-select'));
    expect(screen.getAllByText('Auto — Print dialog').length).toBeGreaterThan(1);
    expect(screen.queryByText('Kitchen printer')).toBeNull();
  });
});

describe('ThermalPaidReceipt', () => {
  const order = () => {
    const builder = createOrderBuilder({ currency: 'EUR', taxContext: { pricesIncludeTax: false, getTaxRatePpm: () => 0 } });
    builder.addLine({ productId: 'shirt', variantId: 'blue', name: 'Blue shirt', unitPrice: { amount: 1200, currency: 'EUR' } });
    builder.addPayment({ method: 'cash', amountMinor: 1500 });
    return builder.getSnapshot();
  };
  const mount = (newSale = vi.fn()) => {
    render(<ThermalPaidReceipt paper="80mm" order={order()} store={{ name: 'Corner Shop', address: '1 High St' }}
      cashier="Brenda" registerId="register-1" footerSlot={<span>email slot</span>} newSale={newSale} />);
    return newSale;
  };
  beforeEach(() => { vi.mocked(printSalePage).mockReset(); });

  it('shows the sale as the template prints it, with the email slot', () => {
    mount();
    const srcdoc = screen.getByTestId('receipt-thermal-frame').getAttribute('srcdoc') ?? '';
    expect(srcdoc).toContain('Blue shirt');
    expect(srcdoc).toContain('Corner Shop');
    expect(screen.getByText('email slot')).toBeTruthy();
  });

  it('prints the page through the print dialog queue', async () => {
    vi.mocked(printSalePage).mockResolvedValue();
    mount();
    await act(async () => { fireEvent.click(screen.getByTestId('receipt-thermal-print')); });
    expect(printSalePage).toHaveBeenCalledWith(screen.getByTestId('receipt-thermal-frame').getAttribute('srcdoc'));
    expect(screen.queryByText("Couldn't print. Try again.")).toBeNull();
  });

  it('says so when the print fails', async () => {
    vi.mocked(printSalePage).mockRejectedValue(new Error('no dialog'));
    mount();
    await act(async () => { fireEvent.click(screen.getByTestId('receipt-thermal-print')); });
    expect(screen.getByText("Couldn't print. Try again.")).toBeTruthy();
  });

  it('starts a new sale', () => {
    const newSale = mount();
    fireEvent.click(screen.getByText('New sale'));
    expect(newSale).toHaveBeenCalledTimes(1);
  });

  // The sale's PosOrder, under an id of its own so the page shows which id it prints.
  const sent = order();
  const posOrder = (serverRefs?: PosOrder['serverRefs']): PosOrder =>
    ({ ...finalizeOrder(sent), id: 'pos-order-till-ab12cd34', syncStatus: serverRefs ? 'applied' : 'pending', serverRefs });
  const frame = (pos?: PosOrder) => {
    render(<ThermalPaidReceipt paper="80mm" order={sent} posOrder={pos} store={{ name: 'Corner Shop' }}
      cashier="Brenda" registerId="register-1" newSale={vi.fn()} />);
    return screen.getByTestId('receipt-thermal-frame').getAttribute('srcdoc') ?? '';
  };

  it("prints the store's reference, last 8 of the till id and the display number, when the store has the order", () => {
    const pos = posOrder({ orderId: 'order_1', displayId: '42', totalMinor: 1200 });
    const srcdoc = frame(pos);
    expect(srcdoc).toContain(orderReference(pos));
    expect(srcdoc).toContain('ab12cd34 · #42');
    expect(srcdoc).not.toContain(sent.id);
  });

  it('prints the last 8 of the till id while the store has no display number yet', () => {
    const srcdoc = frame(posOrder());
    expect(srcdoc).toContain('ab12cd34');
    expect(srcdoc).not.toMatch(/ab12cd34 · #/);
    expect(srcdoc).not.toContain(sent.id);
  });

  it('without a posOrder the page keeps the order id buildReceiptData gives', () => {
    const srcdoc = frame();
    expect(srcdoc).toContain(sent.id);
    expect(srcdoc).not.toContain('ab12cd34');
  });
});
