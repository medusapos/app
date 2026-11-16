import { useState } from 'react';
import { Button, CustomerForm, Text, type CustomerFormValues } from '@tallyui/components';
import { ConnectorUnauthorizedError, CustomerServiceError, type Customer } from '@tallyui/core';

export const NETWORK_ERROR_TEXT = "Couldn't reach the store. Check the connection and try again.";
export const CUSTOMER_SAVE_FAILED = "Couldn't save the customer. Try again.";

export function CustomerEditor({ customer, save, onUnauthorized }: {
  customer: Customer | null;
  save: (values: CustomerFormValues) => Promise<void>;
  onUnauthorized: () => void;
}) {
  const [values, setValues] = useState<CustomerFormValues>({ firstName: customer?.firstName ?? '',
    lastName: customer?.lastName ?? '', email: customer?.email ?? '', phone: customer?.phone ?? '', address: '' });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  async function submit() {
    if (saving || values.email.trim() === '') return;
    setSaving(true);
    setMessage(null);
    try {
      await save(values);
    } catch (error) {
      if (error instanceof ConnectorUnauthorizedError && error.code === 'unauthorized') onUnauthorized();
      else if (error instanceof CustomerServiceError && error.code === 'invalid') setMessage(error.message);
      else if (error instanceof CustomerServiceError && error.code === 'network') setMessage(NETWORK_ERROR_TEXT);
      else setMessage(CUSTOMER_SAVE_FAILED);
    } finally {
      setSaving(false);
    }
  }
  return <>
    <CustomerForm values={values} onChangeField={(field, value) => setValues((current) => ({ ...current, [field]: value }))}
      showAddress={false} />
    {message ? <Text accessibilityRole="alert" className="text-sm text-destructive">{message}</Text> : null}
    <Button testID="customer-save" disabled={saving || values.email.trim() === ''} onPress={submit}>
      <Text>Save customer</Text>
    </Button>
  </>;
}
