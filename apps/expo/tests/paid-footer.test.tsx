// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createOrderBuilder } from '@tallyui/pos';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaidFooter } from '../components/paid-footer';
import { thermalPaidPage } from '../components/receipt-pickers';
import { printSalePage } from '../lib/receipt-templates';

// The print dialog, observed; the rest of the module (templates, page) stays real.
vi.mock('../lib/receipt-templates', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/receipt-templates')>(),
  printSalePage: vi.fn(),
}));

afterEach(cleanup);

describe('PaidFooter', () => {
  const mount = ({ print = vi.fn(), newSale = vi.fn(), email = true }: {
    print?: () => void | Promise<void>; newSale?: () => void; email?: boolean;
  } = {}) => {
    render(<PaidFooter emailReceipt={email ? <button type="button">email slot</button> : undefined} print={print} newSale={newSale} />);
    return { print, newSale };
  };
  const printButton = () => screen.getByRole('button', { name: 'Print receipt' });
  beforeEach(() => { vi.mocked(printSalePage).mockReset(); });

  it('the done button reads doneLabel when given, New sale otherwise', () => {
    const props = { print: vi.fn(), newSale: vi.fn() };
    const { rerender } = render(<PaidFooter {...props} doneLabel="Back" />);
    expect(screen.getByTestId('paid-new-sale').textContent).toBe('Back');
    rerender(<PaidFooter {...props} />);
    expect(screen.getByTestId('paid-new-sale').textContent).toBe('New sale');
  });

  it('holds the email slot, then Print receipt, then New sale, in one print-hidden bar', () => {
    mount();
    const footer = screen.getByTestId('paid-footer');
    expect(footer.getAttribute('data-print')).toBe('hide');
    expect(within(footer).getAllByRole('button').map((button) => button.textContent))
      .toEqual(['email slot', 'Print receipt', 'New sale']);
    expect(within(footer).getByTestId('paid-print').textContent).toBe('Print receipt');
    expect(within(footer).getByTestId('paid-new-sale').textContent).toBe('New sale');
  });

  it('shows only Print receipt and New sale without an email slot', () => {
    mount({ email: false });
    expect(within(screen.getByTestId('paid-footer')).getAllByRole('button').map((button) => button.textContent))
      .toEqual(['Print receipt', 'New sale']);
  });

  it('prints once and shows no status for a plain print', () => {
    const { print } = mount();
    fireEvent.click(printButton());
    expect(print).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('paid-print-status')).toBeNull();
    expect(printButton().getAttribute('aria-disabled')).not.toBe('true');
  });

  it('holds Print while a print is pending and says so when it fails', async () => {
    let fail!: (error: Error) => void;
    const print = vi.fn(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
    mount({ print });
    await act(async () => { fireEvent.click(printButton()); });
    expect(print).toHaveBeenCalledTimes(1);
    expect(printButton().getAttribute('aria-disabled')).toBe('true');
    expect(screen.queryByTestId('paid-print-status')).toBeNull();
    await act(async () => { fail(new Error('no dialog')); });
    expect(screen.getByTestId('paid-print-status').textContent).toBe("Couldn't print. Try again.");
    expect(printButton().getAttribute('aria-disabled')).not.toBe('true');
  });

  it('holds Print during an auto-print and offers a retry when it fails', async () => {
    let fail!: (error: Error) => void;
    const autoPrint = new Promise<void>((_resolve, reject) => { fail = reject; });
    const print = vi.fn();
    render(<PaidFooter autoPrint={autoPrint} print={print} newSale={vi.fn()} />);
    expect(printButton().getAttribute('aria-disabled')).toBe('true');
    expect(screen.queryByTestId('paid-print-status')).toBeNull();
    await act(async () => { fail(new Error('no dialog')); });
    expect(screen.getByTestId('paid-print-status').textContent).toBe("Couldn't print. Try again.");
    expect(printButton().getAttribute('aria-disabled')).not.toBe('true');
    fireEvent.click(printButton());
    expect(print).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('paid-print-status')).toBeNull();
  });

  it('releases Print without a message when an auto-print succeeds', async () => {
    let finish!: () => void;
    const autoPrint = new Promise<void>((resolve) => { finish = resolve; });
    render(<PaidFooter autoPrint={autoPrint} print={vi.fn()} newSale={vi.fn()} />);
    expect(printButton().getAttribute('aria-disabled')).toBe('true');
    await act(async () => { finish(); });
    expect(printButton().getAttribute('aria-disabled')).not.toBe('true');
    expect(screen.queryByTestId('paid-print-status')).toBeNull();
  });

  it('prints a thermal page through the print dialog queue', async () => {
    vi.mocked(printSalePage).mockResolvedValue();
    const builder = createOrderBuilder({ currency: 'EUR', taxContext: { pricesIncludeTax: false, getTaxRatePpm: () => 0 } });
    builder.addLine({ productId: 'shirt', variantId: 'blue', name: 'Blue shirt', unitPrice: { amount: 1200, currency: 'EUR' } });
    builder.addPayment({ method: 'cash', amountMinor: 1500 });
    const page = thermalPaidPage({ paper: '80mm', order: builder.getSnapshot(), store: { name: 'Corner Shop' },
      cashier: 'Brenda', registerId: 'register-1' });
    mount({ print: () => printSalePage(page) });
    await act(async () => { fireEvent.click(printButton()); });
    expect(printSalePage).toHaveBeenCalledWith(page);
    expect(screen.queryByText("Couldn't print. Try again.")).toBeNull();
  });

  it('starts a new sale', () => {
    const { newSale } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'New sale' }));
    expect(newSale).toHaveBeenCalledTimes(1);
  });
});
