// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createOrderBuilder } from '@tallyui/pos';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaidFooter, paidPrintedLabel } from '../components/paid-footer';
import { thermalPaidPage } from '../components/receipt-pickers';
import { printSalePage } from '../lib/receipt-templates';

// The print dialog, observed; the rest of the module (templates, page) stays real.
vi.mock('../lib/receipt-templates', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/receipt-templates')>(),
  printSalePage: vi.fn(),
}));

afterEach(cleanup);

describe('paidPrintedLabel', () => {
  it('names a network printer that confirmed the print', () => {
    expect(paidPrintedLabel({ id: 'counter', name: 'Counter', connectionType: 'network', address: '10.0.0.5' }, 'web'))
      .toBe('Printed to Counter');
  });

  it('says the print dialog on the web without a network printer', () => {
    expect(paidPrintedLabel(undefined, 'web')).toBe('Sent to the print dialog');
  });

  it('says nothing on a native build without a printer', () => {
    expect(paidPrintedLabel(undefined, 'ios')).toBeUndefined();
    expect(paidPrintedLabel(undefined, 'android')).toBeUndefined();
  });
});

describe('PaidFooter', () => {
  const mount = ({ print = vi.fn(), newSale = vi.fn(), email = true }: {
    print?: () => void | Promise<void>; newSale?: () => void; email?: boolean;
  } = {}) => {
    render(<PaidFooter emailReceipt={email ? <button type="button">email slot</button> : undefined} print={print} newSale={newSale} />);
    return { print, newSale };
  };
  const printButton = () => screen.getByRole('button', { name: 'Print receipt' });
  beforeEach(() => { vi.mocked(printSalePage).mockReset(); });

  it('says where a plain print went and offers Print again', () => {
    render(<PaidFooter printedLabel="Sent to the print dialog" print={vi.fn()} newSale={vi.fn()} />);
    expect(screen.queryByTestId('paid-print-done')).toBeNull();
    fireEvent.click(printButton());
    expect(screen.getByTestId('paid-print-done').textContent).toBe('Sent to the print dialog');
    expect(screen.getByRole('button', { name: 'Print again' })).toBeTruthy();
  });

  it('shows Printed to only after the printer confirms', async () => {
    let finish!: () => void;
    const print = () => new Promise<void>((resolve) => { finish = resolve; });
    render(<PaidFooter printedLabel="Printed to Counter" print={print} newSale={vi.fn()} />);
    fireEvent.click(printButton());
    expect(screen.queryByTestId('paid-print-done')).toBeNull();
    expect(printButton().getAttribute('aria-disabled')).toBe('true');
    await act(async () => { finish(); });
    expect(screen.getByTestId('paid-print-done').textContent).toBe('Printed to Counter');
    expect(screen.getByRole('button', { name: 'Print again' }).getAttribute('aria-disabled')).not.toBe('true');
  });

  it('a failed print shows no printed line and keeps Print receipt', async () => {
    render(<PaidFooter printedLabel="Printed to Counter" print={() => Promise.reject(new Error('offline'))} newSale={vi.fn()} />);
    await act(async () => { fireEvent.click(printButton()); });
    expect(screen.getByTestId('paid-print-status').textContent).toBe("Couldn't print. Try again.");
    expect(screen.queryByTestId('paid-print-done')).toBeNull();
    expect(printButton()).toBeTruthy();
  });

  it('a failure after a success keeps Print again', async () => {
    let fail!: (error: Error) => void;
    const print = vi.fn<() => Promise<void>>().mockResolvedValueOnce().mockImplementationOnce(
      () => new Promise<void>((_resolve, reject) => { fail = reject; }));
    render(<PaidFooter printedLabel="Printed to Counter" print={print} newSale={vi.fn()} />);
    await act(async () => { fireEvent.click(printButton()); });
    expect(screen.getByTestId('paid-print-done').textContent).toBe('Printed to Counter');
    fireEvent.click(screen.getByRole('button', { name: 'Print again' }));
    expect(screen.getByRole('button', { name: 'Print again' }).getAttribute('aria-disabled')).toBe('true');
    await act(async () => { fail(new Error('offline')); });
    expect(screen.getByTestId('paid-print-status').textContent).toBe("Couldn't print. Try again.");
    expect(screen.queryByTestId('paid-print-done')).toBeNull();
    expect(screen.getByRole('button', { name: 'Print again' })).toBeTruthy();
  });

  it('an auto-print that succeeds says so, and a remount keeps it', async () => {
    let finish!: () => void;
    const autoPrint = new Promise<void>((resolve) => { finish = resolve; });
    const footer = <PaidFooter printedLabel="Printed to Counter" autoPrint={autoPrint} print={vi.fn()} newSale={vi.fn()} />;
    const view = render(footer);
    await act(async () => { finish(); });
    expect(screen.getByTestId('paid-print-done').textContent).toBe('Printed to Counter');
    expect(screen.getByRole('button', { name: 'Print again' })).toBeTruthy();
    view.unmount();
    render(footer);
    expect(screen.getByTestId('paid-print-done').textContent).toBe('Printed to Counter');
    expect(screen.getByRole('button', { name: 'Print again' })).toBeTruthy();
  });

  it('without printedLabel a successful print shows no line', async () => {
    mount({ print: () => Promise.resolve() });
    await act(async () => { fireEvent.click(printButton()); });
    expect(screen.queryByTestId('paid-print-done')).toBeNull();
    expect(printButton()).toBeTruthy();
  });

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

  it('a remount after a successful retry shows no failure', async () => {
    let fail!: (error: Error) => void;
    const autoPrint = new Promise<void>((_resolve, reject) => { fail = reject; });
    const footer = <PaidFooter autoPrint={autoPrint} print={() => Promise.resolve()} newSale={vi.fn()} />;
    const view = render(footer);
    await act(async () => { fail(new Error('no dialog')); });
    expect(screen.getByTestId('paid-print-status').textContent).toBe("Couldn't print. Try again.");
    await act(async () => { fireEvent.click(printButton()); });
    expect(screen.queryByTestId('paid-print-status')).toBeNull();
    view.unmount();
    await act(async () => { render(footer); });
    expect(screen.queryByTestId('paid-print-status')).toBeNull();
    expect(printButton().getAttribute('aria-disabled')).not.toBe('true');
  });

  it('a remount while the auto-print is pending holds Print, then shows its failure', async () => {
    let fail!: (error: Error) => void;
    const autoPrint = new Promise<void>((_resolve, reject) => { fail = reject; });
    const footer = <PaidFooter autoPrint={autoPrint} print={vi.fn()} newSale={vi.fn()} />;
    render(footer).unmount();
    render(footer);
    expect(printButton().getAttribute('aria-disabled')).toBe('true');
    await act(async () => { fail(new Error('no dialog')); });
    expect(screen.getByTestId('paid-print-status').textContent).toBe("Couldn't print. Try again.");
  });

  it('a different auto-print promise starts fresh', async () => {
    let fail!: (error: Error) => void;
    const first = new Promise<void>((_resolve, reject) => { fail = reject; });
    const props = { print: vi.fn(), newSale: vi.fn() };
    const view = render(<PaidFooter {...props} autoPrint={first} />);
    await act(async () => { fail(new Error('no dialog')); });
    expect(screen.getByTestId('paid-print-status').textContent).toBe("Couldn't print. Try again.");
    view.unmount();
    render(<PaidFooter {...props} autoPrint={new Promise<void>(() => {})} />);
    expect(screen.queryByTestId('paid-print-status')).toBeNull();
    expect(printButton().getAttribute('aria-disabled')).toBe('true');
  });

  it("the latest print decides: an earlier press settling later does not hide the auto-print's failure", async () => {
    let finishPress!: () => void;
    const props = { print: () => new Promise<void>((resolve) => { finishPress = resolve; }), newSale: vi.fn() };
    const view = render(<PaidFooter {...props} />);
    fireEvent.click(printButton());
    let failAuto!: (error: Error) => void;
    const autoPrint = new Promise<void>((_resolve, reject) => { failAuto = reject; });
    view.rerender(<PaidFooter {...props} autoPrint={autoPrint} />);
    await act(async () => { failAuto(new Error('no dialog')); });
    expect(screen.getByTestId('paid-print-status').textContent).toBe("Couldn't print. Try again.");
    await act(async () => { finishPress(); });
    expect(screen.getByTestId('paid-print-status').textContent).toBe("Couldn't print. Try again.");
  });

  it("the latest print decides: an earlier press failing does not end the auto-print's hold", async () => {
    let failPress!: (error: Error) => void;
    const props = { print: () => new Promise<void>((_resolve, reject) => { failPress = reject; }), newSale: vi.fn() };
    const view = render(<PaidFooter {...props} />);
    fireEvent.click(printButton());
    let finishAuto!: () => void;
    const autoPrint = new Promise<void>((resolve) => { finishAuto = resolve; });
    view.rerender(<PaidFooter {...props} autoPrint={autoPrint} />);
    await act(async () => { failPress(new Error('no dialog')); });
    expect(screen.queryByTestId('paid-print-status')).toBeNull();
    expect(printButton().getAttribute('aria-disabled')).toBe('true');
    await act(async () => { finishAuto(); });
    expect(screen.queryByTestId('paid-print-status')).toBeNull();
    expect(printButton().getAttribute('aria-disabled')).not.toBe('true');
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
