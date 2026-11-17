import { useEffect, useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { Button, CustomerForm, Text, type CustomerFormValues } from '@tallyui/components';
import { ConnectorUnauthorizedError, CustomerServiceError, type Customer, type CustomerAddress } from '@tallyui/core';
import { billingAddress, billingChanged, billingCountryValid, billingFields, hasBilling, BillingNotSavedError,
  BILLING_COUNTRY_HINT, BILLING_LOAD_FAILED, BILLING_NOT_SAVED } from '../lib/customer-billing';
import { COUNTRIES, countryName } from '../lib/countries';

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
        [['city', 'City'], ['state', 'State / province']], [['postcode', 'Postal code'], ['country', 'Country']]] as const
      ).map((row) => <View key={row[0][0]} className="flex-row gap-3">
        {row.map(([field, label]) => <View key={field} className="flex-1 gap-1">
          <Text className="text-xs font-medium text-muted-foreground">{label}</Text>
          {field === 'country'
            ? <CountryPicker value={fields.country} disabled={billingStatus !== 'ready'}
              onChange={(country) => setFields((current) => ({ ...current, country }))} />
            : <TextInput accessibilityLabel={label} value={fields[field]} editable={billingStatus === 'ready'}
              onChangeText={(value) => setFields((current) => ({ ...current, [field]: value }))}
              className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground"
              placeholderTextColorClassName="accent-muted-foreground" />}
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

const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
/** Up to 6 countries whose code is the query (those first) or whose name or a word of it starts with it, accent-blind. */
function countryMatches(query: string) {
  const q = fold(query.trim());
  return COUNTRIES.filter(({ code, name }) => code.toLowerCase() === q
    || [fold(name), ...fold(name).split(/[\s\-()[\],'’]+/)].some((part) => q !== '' && part.startsWith(q)))
    .sort((a, b) => Number(b.code.toLowerCase() === q) - Number(a.code.toLowerCase() === q)).slice(0, 6);
}
// Web: pressing a match would blur the field, which closes the list before the press lands; keep the focus instead.
const keepFieldFocus = { onMouseDown: (event: { preventDefault: () => void }) => event.preventDefault() };

/**
 * Picks the billing country by name from every ISO 3166-1 country; the value is the stored code. A stored code
 * that is not in the list is shown as it is, so opening the form never changes it. Matches sit under the field.
 */
function CountryPicker({ value, disabled, onChange }: { value: string; disabled: boolean; onChange: (code: string) => void }) {
  const shown = (code: string) => countryName(code) ?? code;
  const [text, setText] = useState(() => shown(value));
  const [editing, setEditing] = useState(false);
  useEffect(() => { setText(shown(value)); setEditing(false); }, [value]);
  const matches = countryMatches(text);
  const pick = (code: string) => { onChange(code); setText(shown(code)); setEditing(false); };
  return <>
    <TextInput testID="customer-billing-country" accessibilityLabel="Country" value={text} editable={!disabled}
      placeholder="Type a country" onBlur={() => { setText(shown(value)); setEditing(false); }}
      onChangeText={(next) => { setText(next); setEditing(next !== ''); if (next === '') onChange(''); }}
      onSubmitEditing={() => { if (matches[0]) pick(matches[0].code); }}
      className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground"
      placeholderTextColorClassName="accent-muted-foreground" />
    {!disabled && editing && <View testID="customer-billing-country-matches" {...keepFieldFocus}
      className="rounded-lg border border-border bg-card py-1">
      {matches.length === 0 ? <Text className="px-3 py-2 text-sm text-muted-foreground">No matching country</Text>
        : matches.map((country) => <Pressable key={country.code} testID={`customer-billing-country-${country.code}`}
          accessibilityRole="button" onPress={() => pick(country.code)} className="px-3 py-2">
          <Text className="text-sm text-foreground">{country.name}</Text>
        </Pressable>)}
    </View>}
  </>;
}
