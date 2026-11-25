import { ConnectorUnauthorizedError, CustomerServiceError, type OrderAddress, type SyncContext } from '@tallyui/core';
import { mapAddress } from './customer-billing';

// The address fields the Billing Address cell shows; the name, company and phone are neither read nor shown.
const BILLING_FIELDS = ['address_1', 'address_2', 'city', 'province', 'postal_code', 'country_code'];

/** The Orders table's Billing Address: street, city, state, postcode and country, joined; null when nothing is left. */
export function formatOrderAddress(address: OrderAddress | null | undefined): string | null {
  const parts = [address?.address1, address?.address2, address?.city, address?.state, address?.postcode,
    address?.country?.toUpperCase()].map((part) => part?.trim() ?? '').filter((part) => part !== '');
  return parts.length > 0 ? parts.join(', ') : null;
}

/** The store orders' billing addresses, formatted, by order id: null for an order without one; absent when not answered.
 *  TallyUI's StoreOrder has no billing address, so the app reads it from Medusa, as loadCustomerAddresses does. */
export async function loadOrderBilling(context: SyncContext, ids: string[]): Promise<Map<string, string | null>> {
  const billing = new Map<string, string | null>();
  if (ids.length === 0) return billing;
  const query = ids.map((id) => `id[]=${encodeURIComponent(id)}`).join('&');
  const fields = ['id', ...BILLING_FIELDS.map((field) => `billing_address.${field}`)].join(',');
  let response: Response;
  try {
    response = await (context.fetch ?? fetch)(`${context.baseUrl}/admin/orders?${query}&limit=${ids.length}&fields=${fields}`,
      { headers: context.headers, signal: context.signal });
  } catch (error) { throw new CustomerServiceError('network', error instanceof Error ? error.message : String(error)); }
  if (response.status === 401 || response.status === 403) throw new ConnectorUnauthorizedError(`HTTP ${response.status}`, response.status);
  if (!response.ok) throw new CustomerServiceError('server', `HTTP ${response.status}`, { status: response.status });
  const body = await response.json();
  if (!Array.isArray(body?.orders)) throw new CustomerServiceError('server', 'unexpected response', { status: response.status });
  const asked = new Set(ids);
  for (const order of body.orders as { id?: unknown; billing_address?: unknown }[]) {
    if (typeof order?.id !== 'string' || !asked.has(order.id)) continue;
    const stored = order.billing_address;
    billing.set(order.id, stored && typeof stored === 'object' ? formatOrderAddress(mapAddress(stored as Record<string, unknown>)) : null);
  }
  return billing;
}
