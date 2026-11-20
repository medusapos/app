// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PortalHost } from '@tallyui/primitives';
import { createOrderBuilder, type PrinterProfile } from '@tallyui/pos';
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
});
