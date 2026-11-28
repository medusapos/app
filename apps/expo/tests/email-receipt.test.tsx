// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectorUnauthorizedError, CustomerServiceError } from '@tallyui/core';
import { PortalHost } from '@tallyui/primitives';
import { useState, type ComponentProps, type ReactNode } from 'react';
import { EmailReceipt, EmailReceiptSent } from '../components/email-receipt';
import { RECEIPT_EMAIL_FAILED } from '../lib/receipt-email';

vi.mock('expo-localization', () => ({ getCalendars: () => [{ uses24hourClock: null }] }));

const send = vi.fn<(orderId: string, email: string) => Promise<void>>();
const onUnauthorized = vi.fn();
const props = { orderId: 'store-order', online: true, defaultEmail: 'buyer@example.com', send, onUnauthorized };
beforeEach(() => { send.mockReset().mockResolvedValue(undefined); onUnauthorized.mockReset(); });
afterEach(cleanup);

// The dialog renders into a portal in document.body (the app mounts its PortalHost at the root), so it is read through
// screen, never container.
const Host = ({ children }: { children: ReactNode }) => <>{children}<PortalHost /></>;
const field = () => screen.getByLabelText('Email Address') as HTMLInputElement;
const sendButton = () => screen.getByTestId('receipt-email-send');

function Harness(props: Omit<ComponentProps<typeof EmailReceipt>, 'onSentChange'>) {
  const [sentTo, setSentTo] = useState<string | null>(null);
  return <><EmailReceipt {...props} onSentChange={setSentTo} />
    {sentTo ? <EmailReceiptSent email={sentTo} /> : null}</>;
}

describe('EmailReceipt', () => {
  it('starts as a button hidden from print, then opens the prefilled Email Receipt dialog without sending', () => {
    const { container } = render(<Harness {...props} />, { wrapper: Host });
    expect(container.firstElementChild?.getAttribute('data-print')).toBe('hide');
    expect(screen.getByTestId('receipt-email-open')).toBeTruthy();
    expect(screen.queryByTestId('receipt-email-dialog')).toBeNull();
    expect(screen.queryByLabelText('Email Address')).toBeNull();
    fireEvent.click(screen.getByTestId('receipt-email-open'));
    expect(screen.getByTestId('receipt-email-dialog')).toBeTruthy();
    expect(screen.getByText('Email Receipt')).toBeTruthy();
    expect(screen.getByText('Email Address')).toBeTruthy();
    expect(field().value).toBe('buyer@example.com');
    expect(send).not.toHaveBeenCalled();
  });

  it('opens with an empty field and Send disabled when there is no email, also for whitespace', () => {
    render(<Harness {...props} defaultEmail={undefined} />, { wrapper: Host });
    fireEvent.click(screen.getByTestId('receipt-email-open'));
    expect(field().value).toBe('');
    expect(sendButton().getAttribute('aria-disabled')).toBe('true');
    fireEvent.change(field(), { target: { value: '   ' } });
    expect(sendButton().getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(sendButton());
    expect(send).not.toHaveBeenCalled();
  });

  it('sends the trimmed address once, closes on success and confirms under the button', async () => {
    let resolve!: () => void;
    send.mockReturnValueOnce(new Promise<void>((done) => { resolve = done; }));
    render(<Harness {...props} />, { wrapper: Host });
    fireEvent.click(screen.getByTestId('receipt-email-open'));
    fireEvent.change(field(), { target: { value: '  other@example.com  ' } });
    expect(send).not.toHaveBeenCalled();
    fireEvent.click(sendButton());
    expect(send).toHaveBeenCalledExactlyOnceWith('store-order', 'other@example.com');
    expect(sendButton().textContent).toBe('Sending…');
    expect(sendButton().getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByTestId('receipt-email-cancel').getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(sendButton());
    expect(send).toHaveBeenCalledTimes(1);
    await act(async () => { resolve(); });
    expect(screen.queryByTestId('receipt-email-dialog')).toBeNull();
    expect(screen.getByRole('alert').textContent).toBe('Receipt sent to other@example.com.');
    expect(screen.getByTestId('receipt-email-open')).toBeTruthy();
    fireEvent.click(screen.getByTestId('receipt-email-open'));
    expect(field().value).toBe('buyer@example.com');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('keeps the dialog, address and store error, retrying only on another press', async () => {
    const message = "This store has no email provider set up, so it can't email receipts.";
    send.mockRejectedValueOnce(new CustomerServiceError('server', message, { status: 503 }));
    render(<Harness {...props} />, { wrapper: Host });
    fireEvent.click(screen.getByTestId('receipt-email-open'));
    // act, not findBy: findBy resumes on the DOM change, but react-native-web's Pressable re-reads
    // disabled/onPress in a passive effect, so on a stalled runner the retry press hit the stale handler.
    await act(async () => { fireEvent.click(sendButton()); });
    expect(screen.getByTestId('receipt-email-dialog')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe(message);
    expect(field().value).toBe('buyer@example.com');
    expect(sendButton().getAttribute('aria-disabled')).not.toBe('true');
    expect(send).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(sendButton()); });
    expect(send).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('receipt-email-dialog')).toBeNull();
    expect(screen.getByText('Receipt sent to buyer@example.com.').getAttribute('role')).toBe('alert');
  });

  it.each([401, 403] as const)('handles HTTP %s in the open dialog without signing out for forbidden access', async (status) => {
    send.mockRejectedValue(new ConnectorUnauthorizedError('Credentials refused', status));
    render(<Harness {...props} />, { wrapper: Host });
    fireEvent.click(screen.getByTestId('receipt-email-open'));
    await act(async () => { fireEvent.click(sendButton()); });
    expect(screen.getByRole('alert').textContent).toBe(RECEIPT_EMAIL_FAILED);
    expect(screen.getByTestId('receipt-email-dialog')).toBeTruthy();
    expect(onUnauthorized).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(field().value).toBe('buyer@example.com');
  });

  it('shows fallback copy in the dialog for an unexpected failure without retrying', async () => {
    send.mockRejectedValue(new Error('Unexpected failure'));
    render(<Harness {...props} />, { wrapper: Host });
    fireEvent.click(screen.getByTestId('receipt-email-open'));
    await act(async () => { fireEvent.click(sendButton()); });
    expect(screen.getByRole('alert').textContent).toBe(RECEIPT_EMAIL_FAILED);
    expect(screen.getByTestId('receipt-email-dialog')).toBeTruthy();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(['receipt-email-cancel', 'receipt-email-x'])('closes on %s without sending', (testID) => {
    render(<Harness {...props} />, { wrapper: Host });
    fireEvent.click(screen.getByTestId('receipt-email-open'));
    fireEvent.change(field(), { target: { value: 'other@example.com' } });
    fireEvent.click(screen.getByTestId(testID));
    expect(screen.queryByTestId('receipt-email-dialog')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it('waits for the store id in the dialog and enables after rerender without sending', () => {
    const { rerender } = render(<Harness {...props} orderId={undefined} />, { wrapper: Host });
    fireEvent.click(screen.getByTestId('receipt-email-open'));
    expect(screen.getByText('You can email the receipt once this sale reaches the store.')).toBeTruthy();
    expect(sendButton().getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(sendButton());
    rerender(<Harness {...props} />);
    expect(sendButton().getAttribute('aria-disabled')).not.toBe('true');
    expect(screen.queryByText('You can email the receipt once this sale reaches the store.')).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it('prioritizes the offline hint in the dialog and never sends on reconnect', () => {
    const { rerender } = render(<Harness {...props} online={false} orderId={undefined} />, { wrapper: Host });
    fireEvent.click(screen.getByTestId('receipt-email-open'));
    expect(screen.getByText('Connect to the store to email this receipt.')).toBeTruthy();
    expect(screen.queryByText('You can email the receipt once this sale reaches the store.')).toBeNull();
    expect(sendButton().getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(sendButton());
    rerender(<Harness {...props} />);
    expect(sendButton().getAttribute('aria-disabled')).not.toBe('true');
    expect(send).not.toHaveBeenCalled();
  });
});
