import { ConnectorUnauthorizedError, CustomerServiceError, type TallyConnector } from '@tallyui/core';

export const RECEIPT_EMAIL_FAILED = "Couldn't send the receipt. Try again.";

export const emailReceipt: NonNullable<TallyConnector['emailReceipt']> = async (context, orderId, email, options) => {
  let response: Response;
  try {
    response = await globalThis.fetch(`${context.baseUrl.replace(/\/+$/, '')}/tally/v1/orders/${encodeURIComponent(orderId)}/receipt-email`, {
      method: 'POST',
      headers: { ...context.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, ...(options?.saveToBilling !== undefined ? { saveToBilling: options.saveToBilling } : {}) }),
      signal: context.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new CustomerServiceError('network', RECEIPT_EMAIL_FAILED);
  }
  if (response.ok) return;

  let message = RECEIPT_EMAIL_FAILED;
  try {
    const body: unknown = await response.json();
    if (typeof body === 'object' && body !== null && 'message' in body &&
      typeof body.message === 'string' && body.message.length > 0) message = body.message;
  } catch {
    // A non-JSON error response uses the same receipt-specific copy.
  }
  const status = response.status;
  if (status === 401 || status === 403) throw new ConnectorUnauthorizedError(message, status);
  throw new CustomerServiceError(status === 400 || status === 404 ? 'invalid' : 'server', message, { status });
};
