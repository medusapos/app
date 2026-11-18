// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectorUnauthorizedError, CustomerServiceError } from '@tallyui/core';
import { EmailReceipt } from '../components/email-receipt';
import { RECEIPT_EMAIL_FAILED } from '../lib/receipt-email';

vi.mock('expo-localization', () => ({ getCalendars: () => [{ uses24hourClock: null }] }));

const send = vi.fn<(orderId: string, email: string) => Promise<void>>();
const onUnauthorized = vi.fn();
const props = { orderId: 'store-order', online: true, defaultEmail: 'buyer@example.com', send, onUnauthorized };
beforeEach(() => { send.mockReset().mockResolvedValue(undefined); onUnauthorized.mockReset(); });
afterEach(cleanup);

describe('EmailReceipt', () => {
  it('shows the email receipt placeholder after opening the form', () => {
    render(<EmailReceipt {...props} />);
    fireEvent.click(screen.getByTestId('receipt-email-open'));
    expect(screen.getByLabelText('Receipt email address').getAttribute('placeholder')).toBe('Email receipt to');
  });

  it('starts closed and hidden from print, then prefills the form without sending', () => {
    const { container } = render(<EmailReceipt {...props} />);
    expect(container.firstElementChild?.getAttribute('data-print')).toBe('hide');
    expect(screen.queryByLabelText('Receipt email address')).toBeNull();
    fireEvent.click(screen.getByTestId('receipt-email-open'));
    expect((screen.getByLabelText('Receipt email address') as HTMLInputElement).value).toBe('buyer@example.com');
    expect(send).not.toHaveBeenCalled();
  });

  it('waits for the store id and enables after rerender without sending', () => {
    const { rerender } = render(<EmailReceipt {...props} orderId={undefined} />);
    fireEvent.click(screen.getByTestId('receipt-email-open'));
    expect(screen.getByText('You can email the receipt once this sale reaches the store.')).toBeTruthy();
    expect(screen.getByTestId('receipt-email-send').getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(screen.getByTestId('receipt-email-send'));
    rerender(<EmailReceipt {...props} />);
    expect(screen.getByTestId('receipt-email-send').getAttribute('aria-disabled')).not.toBe('true');
    expect(screen.queryByText('You can email the receipt once this sale reaches the store.')).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it('prioritizes the offline hint and never sends on reconnect', () => {
    const { rerender } = render(<EmailReceipt {...props} online={false} orderId={undefined} />);
    fireEvent.click(screen.getByTestId('receipt-email-open'));
    expect(screen.getByText('Connect to the store to email this receipt.')).toBeTruthy();
    expect(screen.queryByText('You can email the receipt once this sale reaches the store.')).toBeNull();
    expect(screen.getByTestId('receipt-email-send').getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(screen.getByTestId('receipt-email-send'));
    rerender(<EmailReceipt {...props} />);
    expect(screen.getByTestId('receipt-email-send').getAttribute('aria-disabled')).not.toBe('true');
    expect(send).not.toHaveBeenCalled();
  });

  it('disables an empty or whitespace-only address', () => {
    render(<EmailReceipt {...props} defaultEmail={undefined} />);
    fireEvent.click(screen.getByTestId('receipt-email-open'));
    const input = screen.getByLabelText('Receipt email address') as HTMLInputElement;
    expect(input.value).toBe('');
    expect(screen.getByTestId('receipt-email-send').getAttribute('aria-disabled')).toBe('true');
    fireEvent.change(input, { target: { value: '   ' } });
    expect(screen.getByTestId('receipt-email-send').getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(screen.getByTestId('receipt-email-send'));
    expect(send).not.toHaveBeenCalled();
  });

  it('sends the trimmed address once, shows progress and success, then opens an empty form', async () => {
    let resolve!: () => void;
    send.mockReturnValueOnce(new Promise<void>((done) => { resolve = done; }));
    render(<EmailReceipt {...props} />);
    fireEvent.click(screen.getByTestId('receipt-email-open'));
    fireEvent.change(screen.getByLabelText('Receipt email address'), { target: { value: '  other@example.com  ' } });
    expect(send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('receipt-email-send'));
    expect(send).toHaveBeenCalledExactlyOnceWith('store-order', 'other@example.com');
    expect(screen.getByTestId('receipt-email-send').textContent).toBe('Sending…');
    expect(screen.getByTestId('receipt-email-send').getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(screen.getByTestId('receipt-email-send'));
    expect(send).toHaveBeenCalledTimes(1);
    await act(async () => { resolve(); });
    expect(screen.getByRole('alert').textContent).toBe('Receipt sent to other@example.com.');
    expect(screen.queryByLabelText('Receipt email address')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Send to another address' }));
    expect((screen.getByLabelText('Receipt email address') as HTMLInputElement).value).toBe('');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('keeps the address and store error, retrying only on another press', async () => {
    const message = "This store has no email provider set up, so it can't email receipts.";
    send.mockRejectedValueOnce(new CustomerServiceError('server', message, { status: 503 }));
    render(<EmailReceipt {...props} />);
    fireEvent.click(screen.getByTestId('receipt-email-open'));
    fireEvent.click(screen.getByTestId('receipt-email-send'));
    // 5 s waits: the default 1 s findBy timeout flaked on loaded CI runners.
    expect((await screen.findByRole('alert', {}, { timeout: 5000 })).textContent).toBe(message);
    expect((screen.getByLabelText('Receipt email address') as HTMLInputElement).value).toBe('buyer@example.com');
    expect(screen.getByTestId('receipt-email-send').getAttribute('aria-disabled')).not.toBe('true');
    expect(send).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('receipt-email-send'));
    expect((await screen.findByText('Receipt sent to buyer@example.com.', {}, { timeout: 5000 })).getAttribute('role')).toBe('alert');
    expect(send).toHaveBeenCalledTimes(2);
  }, 15_000);

  it.each([401, 403] as const)('handles HTTP %s without signing out for forbidden access', async (status) => {
    send.mockRejectedValue(new ConnectorUnauthorizedError('Credentials refused', status));
    render(<EmailReceipt {...props} />);
    fireEvent.click(screen.getByTestId('receipt-email-open'));
    fireEvent.click(screen.getByTestId('receipt-email-send'));
    expect((await screen.findByRole('alert')).textContent).toBe(RECEIPT_EMAIL_FAILED);
    expect(onUnauthorized).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
    expect(send).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText('Receipt email address') as HTMLInputElement).value).toBe('buyer@example.com');
  });

  it('shows fallback copy for an unexpected failure without retrying', async () => {
    send.mockRejectedValue(new Error('Unexpected failure'));
    render(<EmailReceipt {...props} />);
    fireEvent.click(screen.getByTestId('receipt-email-open'));
    fireEvent.click(screen.getByTestId('receipt-email-send'));
    expect((await screen.findByRole('alert')).textContent).toBe(RECEIPT_EMAIL_FAILED);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
