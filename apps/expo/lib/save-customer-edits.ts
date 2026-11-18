import type { CustomerFormValues } from '@tallyui/components';
import type { Customer, CustomerAddress, CustomerPatch } from '@tallyui/core';

/**
 * Saves an edit of a stored customer: only the trimmed name, email and phone fields that differ from `customer`, plus the
 * billing and shipping addresses the editor decided to write. Returns the updated customer, or null when nothing changed.
 */
export async function saveCustomerEdits(update: (id: string, patch: CustomerPatch) => Promise<Customer>, customer: Customer,
  values: CustomerFormValues, billing: CustomerAddress | undefined, shipping: CustomerAddress | undefined): Promise<Customer | null> {
  const patch: CustomerPatch = {};
  for (const field of ['firstName', 'lastName', 'email', 'phone'] as const) {
    if (values[field].trim() !== (customer[field] ?? '')) patch[field] = values[field].trim();
  }
  if (billing !== undefined) patch.billing = billing;
  if (shipping !== undefined) patch.shipping = shipping;
  return Object.keys(patch).length ? update(customer.id, patch) : null;
}
