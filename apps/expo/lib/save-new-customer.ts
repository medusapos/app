import type { CustomerFormValues } from '@tallyui/components';
import type { Customer, CustomerAddress, CustomerInput, CustomerPatch } from '@tallyui/core';
import { BillingNotSavedError } from './customer-billing';

/**
 * Creates a customer from the new-customer form. `created` keeps the customer already created by an earlier Save, so a
 * second Save after a failed billing update patches that customer instead of creating a second one.
 */
export async function saveNewCustomer(
  connector: { create: (input: CustomerInput) => Promise<Customer>; update?: (id: string, patch: CustomerPatch) => Promise<Customer> },
  values: CustomerFormValues, billing: CustomerAddress | undefined, shipping: CustomerAddress | undefined,
  created: { current: Customer | null },
  onSaved?: (customer: Customer) => void,
): Promise<Customer> {
  const patch: CustomerPatch = {};
  if (created.current) {
    for (const field of ['firstName', 'lastName', 'email', 'phone'] as const) {
      if (values[field].trim() !== (created.current[field] ?? '')) patch[field] = values[field].trim();
    }
  }
  const input = { email: values.email.trim(),
    ...(values.firstName.trim() ? { firstName: values.firstName.trim() } : {}),
    ...(values.lastName.trim() ? { lastName: values.lastName.trim() } : {}),
    ...(values.phone.trim() ? { phone: values.phone.trim() } : {}) };
  const customer = created.current ?? await connector.create(input);
  created.current = customer;
  onSaved?.(customer);
  if ((Object.keys(patch).length || billing !== undefined || shipping !== undefined) && connector.update) {
    try {
      const updated = await connector.update(customer.id, { ...patch,
        ...(billing !== undefined ? { billing } : {}), ...(shipping !== undefined ? { shipping } : {}) });
      created.current = updated;
      onSaved?.(updated);
      return updated;
    } catch (error) { throw new BillingNotSavedError(customer, error); }
  }
  return customer;
}
