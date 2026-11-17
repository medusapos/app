import { ConnectorUnauthorizedError, CustomerServiceError, type Customer, type CustomerAddress, type SyncContext } from '@tallyui/core';

export type BillingFields = { address1: string; address2: string; city: string; state: string; postcode: string; country: string };
export const EMPTY_BILLING: BillingFields = { address1: '', address2: '', city: '', state: '', postcode: '', country: '' };
const keys = Object.keys(EMPTY_BILLING) as (keyof BillingFields)[];
export const BILLING_NOT_SAVED = 'The customer was saved, but not the billing address. Save again to try the address again.';
export const BILLING_LOAD_FAILED = "Couldn't load the stored billing address, so it can't be changed now. The other details can still be saved.";
export const BILLING_COUNTRY_HINT = "The stored country isn't a two-letter code. Choose a country from the list.";

export function billingFields(address: CustomerAddress | undefined): BillingFields {
  return Object.fromEntries(keys.map((key) => [key, address?.[key] ?? ''])) as BillingFields;
}
export function billingCountryValid(fields: BillingFields): boolean {
  return /^(?:[a-z]{2})?$/i.test(fields.country.trim());
}
export function billingChanged(fields: BillingFields, stored: CustomerAddress | undefined): boolean {
  const previous = billingFields(stored);
  return keys.some((key) => key === 'country'
    ? fields[key].trim().toUpperCase() !== previous[key].trim().toUpperCase() : fields[key].trim() !== previous[key].trim());
}
export function billingAddress(fields: BillingFields, base: CustomerAddress): CustomerAddress {
  const address = { ...base };
  for (const key of keys) {
    const value = fields[key].trim();
    if (value) address[key] = key === 'country' ? value.toUpperCase() : value;
    else delete address[key];
  }
  return address;
}
export function hasBilling(fields: BillingFields): boolean {
  return keys.some((key) => fields[key].trim() !== '');
}

export async function loadCustomerBilling(context: SyncContext, id: string): Promise<CustomerAddress | undefined> {
  let response: Response;
  try {
    response = await (context.fetch ?? fetch)(`${context.baseUrl}/admin/customers/${encodeURIComponent(id)}?fields=id,*addresses`,
      { headers: context.headers, signal: context.signal });
  } catch (error) { throw new CustomerServiceError('network', error instanceof Error ? error.message : String(error)); }
  if (response.status === 401 || response.status === 403) throw new ConnectorUnauthorizedError(`HTTP ${response.status}`, response.status);
  if (!response.ok) throw new CustomerServiceError('server', `HTTP ${response.status}`, { status: response.status });
  const body = await response.json();
  if (!body?.customer) throw new CustomerServiceError('server', 'unexpected response', { status: response.status });
  const stored = body.customer.addresses?.find((address: { is_default_billing?: boolean }) => address.is_default_billing === true);
  if (!stored) return undefined;
  const address: CustomerAddress = {};
  const mapping = { first_name: 'firstName', last_name: 'lastName', company: 'company', address_1: 'address1',
    address_2: 'address2', city: 'city', province: 'state', postal_code: 'postcode', country_code: 'country', phone: 'phone' } as const;
  for (const [source, key] of Object.entries(mapping)) {
    const value = stored[source];
    if (typeof value === 'string' && value !== '') address[key] = key === 'country' ? value.toUpperCase() : value;
  }
  return address;
}

export class BillingNotSavedError extends Error {
  constructor(readonly customer: Customer, readonly cause: unknown) {
    super(BILLING_NOT_SAVED);
    this.name = 'BillingNotSavedError';
  }
}
