import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectorUnauthorizedError, CustomerServiceError, type SyncContext } from '@tallyui/core';
import { emailReceipt, RECEIPT_EMAIL_FAILED } from './receipt-email';

const context: SyncContext = {
  connectorId: 'medusa', baseUrl: 'https://store.test///', headers: { Authorization: 'Bearer token' },
  signal: new AbortController().signal,
};
const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => vi.unstubAllGlobals());

describe('emailReceipt', () => {
  it('posts to the encoded order URL with context headers, signal and only the email by default', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 202 }));
    await expect(emailReceipt(context, 'order/1 #', 'buyer@example.com')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      'https://store.test/tally/v1/orders/order%2F1%20%23/receipt-email',
      { method: 'POST', headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'buyer@example.com' }), signal: context.signal },
    );
  });

  it.each([undefined, true, false])('includes saveToBilling only when defined (%s)', async (saveToBilling) => {
    fetchMock.mockResolvedValue(new Response(null, { status: 202 }));
    await emailReceipt(context, 'order', 'buyer@example.com', { saveToBilling });
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string)).toEqual({
      email: 'buyer@example.com', ...(saveToBilling !== undefined ? { saveToBilling } : {}),
    });
  });

  it.each([200, 202, 204, 299])('accepts HTTP %s without reading a response body', async (status) => {
    fetchMock.mockResolvedValue(new Response(null, { status }));
    await expect(emailReceipt(context, 'order', 'buyer@example.com')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403])('maps HTTP %s to a credential error with the store message', async (status) => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ message: 'Store denied access.' }), { status }));
    const result = emailReceipt(context, 'order', 'buyer@example.com');
    await expect(result).rejects.toBeInstanceOf(ConnectorUnauthorizedError);
    await expect(result).rejects.toMatchObject({ status, message: 'Store denied access.',
      code: status === 401 ? 'unauthorized' : 'forbidden' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([[400, 'invalid'], [404, 'invalid'], [503, 'server']])('maps HTTP %s to %s', async (status, code) => {
    const message = "This store has no email provider set up, so it can't email receipts.";
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ message }), { status: status as number }));
    const result = emailReceipt(context, 'order', 'buyer@example.com');
    await expect(result).rejects.toBeInstanceOf(CustomerServiceError);
    await expect(result).rejects.toMatchObject({ status, code, message });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['Bad gateway', '{}', '{"message":""}', '{"message":42}', 'null'])('uses fallback copy for %s', async (body) => {
    fetchMock.mockResolvedValue(new Response(body, { status: 502 }));
    const result = emailReceipt(context, 'order', 'buyer@example.com');
    await expect(result).rejects.toBeInstanceOf(CustomerServiceError);
    await expect(result).rejects.toMatchObject({ status: 502, code: 'server', message: RECEIPT_EMAIL_FAILED });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps a rejected fetch to a network error without retrying', async () => {
    fetchMock.mockRejectedValue(new TypeError('Connection lost'));
    const result = emailReceipt(context, 'order', 'buyer@example.com');
    await expect(result).rejects.toBeInstanceOf(CustomerServiceError);
    await expect(result).rejects.toMatchObject({ code: 'network', message: RECEIPT_EMAIL_FAILED, status: undefined });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rethrows an AbortError unchanged without retrying', async () => {
    const error = new DOMException('Aborted', 'AbortError');
    fetchMock.mockRejectedValue(error);
    await expect(emailReceipt(context, 'order', 'buyer@example.com')).rejects.toBe(error);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
