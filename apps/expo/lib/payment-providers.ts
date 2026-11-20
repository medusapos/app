import { authHeaders } from './pos-connector';
import type { Session } from './session';

export type PaymentProvider = { id: string; name: string; tillCanTake: boolean };

function isProvider(row: unknown): row is PaymentProvider {
  if (typeof row !== 'object' || row === null) return false;
  const { id, name, tillCanTake } = row as Record<string, unknown>;
  return typeof id === 'string' && typeof name === 'string' && typeof tillCanTake === 'boolean';
}

// The store's Medusa payment providers for Settings › Card readers; null when the plugin can't say (an older one answers 404).
export async function fetchPaymentProviders(session: Pick<Session, 'baseUrl' | 'token'>,
  fetchImpl = globalThis.fetch): Promise<PaymentProvider[] | null> {
  try {
    const response = await fetchImpl(`${session.baseUrl}/tally/v1/payment-providers`, { headers: authHeaders(session.token) });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null || !('providers' in body) || !Array.isArray(body.providers)) return null;
    return body.providers.filter(isProvider).map(({ id, name, tillCanTake }) => ({ id, name, tillCanTake }));
  } catch { return null; }
}
