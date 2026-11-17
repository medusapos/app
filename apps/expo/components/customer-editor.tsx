import { useEffect, useState } from 'react';
import { TextInput, View } from 'react-native';
import { Button, CustomerForm, Text, type CustomerFormValues } from '@tallyui/components';
import { ConnectorUnauthorizedError, CustomerServiceError, type Customer, type CustomerAddress } from '@tallyui/core';
import { billingAddress, billingChanged, billingCountryValid, billingFields, hasBilling, BillingNotSavedError,
  BILLING_COUNTRY_HINT, BILLING_LOAD_FAILED, BILLING_NOT_SAVED } from '../lib/customer-billing';

export const NETWORK_ERROR_TEXT = "Couldn't reach the store. Check the connection and try again.";
export const CUSTOMER_SAVE_FAILED = "Couldn't save the customer. Try again.";

export function CustomerEditor({ customer, save, onUnauthorized, loadBilling }: {
  customer: Customer | null;
  save: (values: CustomerFormValues, billing: CustomerAddress | undefined) => Promise<void>;
  onUnauthorized: () => void;
  /** Reads the stored billing address of `customer`; used only when `customer` is not null. */
  loadBilling?: () => Promise<CustomerAddress | undefined>;
}) {
  const [values, setValues] = useState<CustomerFormValues>({ firstName: customer?.firstName ?? '',
    lastName: customer?.lastName ?? '', email: customer?.email ?? '', phone: customer?.phone ?? '', address: '' });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [stored, setStored] = useState(customer && !loadBilling ? customer.billing : undefined);
  const [fields, setFields] = useState(() => billingFields(stored));
  const [billingStatus, setBillingStatus] = useState(customer && loadBilling ? 'loading' : 'ready');
  const countryValid = billingCountryValid(fields);
  useEffect(() => {
    if (!customer || !loadBilling) return;
    void loadBilling().then((address) => {
      setStored(address);
      setFields(billingFields(address));
      setBillingStatus('ready');
    }, (error) => {
      setBillingStatus('failed');
      if (error instanceof ConnectorUnauthorizedError && error.code === 'unauthorized') onUnauthorized();
    });
  }, []);
  async function submit() {
    if (saving || values.email.trim() === '' || !countryValid) return;
    setSaving(true);
    setMessage(null);
    try {
      const namesBase = { ...(values.firstName.trim() ? { firstName: values.firstName.trim() } : {}),
        ...(values.lastName.trim() ? { lastName: values.lastName.trim() } : {}) };
      const changed = customer ? billingStatus === 'ready' && billingChanged(fields, stored) : hasBilling(fields);
      await save(values, changed ? billingAddress(fields, stored ?? namesBase) : undefined);
    } catch (error) {
      if (error instanceof BillingNotSavedError) {
        setMessage(BILLING_NOT_SAVED);
        if (error.cause instanceof ConnectorUnauthorizedError && error.cause.code === 'unauthorized') onUnauthorized();
      } else if (error instanceof ConnectorUnauthorizedError && error.code === 'unauthorized') onUnauthorized();
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
    <View className="gap-3 p-4">
      <Text className="text-sm font-medium text-foreground">Billing address</Text>
      {([[['address1', 'Address line 1']], [['address2', 'Address line 2']],
        [['city', 'City'], ['state', 'State / province']], [['postcode', 'Postal code'], ['country', 'Country code']]] as const
      ).map((row) => <View key={row[0][0]} className="flex-row gap-3">
        {row.map(([field, label]) => <View key={field} className="flex-1 gap-1">
          <Text className="text-xs font-medium text-muted-foreground">{label}</Text>
          <TextInput accessibilityLabel={label} value={fields[field]} editable={billingStatus === 'ready'}
            onChangeText={(value) => setFields((current) => ({ ...current, [field]: value }))}
            className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground"
            placeholderTextColorClassName="accent-muted-foreground"
            {...(field === 'country' ? { autoCapitalize: 'characters' as const, maxLength: 2, placeholder: 'GB' } : {})} />
        </View>)}
      </View>)}
      {billingStatus === 'failed' && <Text className="text-sm text-muted-foreground">{BILLING_LOAD_FAILED}</Text>}
      {!countryValid && <Text className="text-sm text-destructive">{BILLING_COUNTRY_HINT}</Text>}
    </View>
    {message ? <Text accessibilityRole="alert" className="text-sm text-destructive">{message}</Text> : null}
    <Button testID="customer-save" disabled={saving || values.email.trim() === '' || !countryValid} onPress={submit}>
      <Text>Save customer</Text>
    </Button>
  </>;
}
