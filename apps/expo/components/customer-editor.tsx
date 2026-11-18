import { useEffect, useState, type ReactNode } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { Button, CustomerForm, Text, type CustomerFormValues } from '@tallyui/components';
import { ConnectorUnauthorizedError, CustomerServiceError, type Customer, type CustomerAddress } from '@tallyui/core';
import { billingAddress, billingChanged, billingCountryValid, billingFields, hasBilling, BillingNotSavedError,
  BILLING_COUNTRY_HINT, BILLING_LOAD_FAILED, BILLING_NOT_SAVED, SHIPPING_COUNTRY_HINT, type BillingFields } from '../lib/customer-billing';
import { COUNTRIES, countryName } from '../lib/countries';

export const NETWORK_ERROR_TEXT = "Couldn't reach the store. Check the connection and try again.";
export const CUSTOMER_SAVE_FAILED = "Couldn't save the customer. Try again.";

type Addresses = { billing?: CustomerAddress; shipping?: CustomerAddress };
/** Shipping starts as "Same as billing" when there is none stored or its six fields match billing's. */
const shippingIsBilling = ({ billing, shipping }: Addresses) => !shipping || !billingChanged(billingFields(shipping), billing);

export function CustomerEditor({ customer, save, onUnauthorized, loadAddresses, layout, saveLabel = 'Save customer' }: {
  customer: Customer | null;
  save: (values: CustomerFormValues, billing: CustomerAddress | undefined, shipping: CustomerAddress | undefined) => Promise<void>;
  onUnauthorized: () => void;
  /** Reads the stored billing and shipping addresses of `customer`; used only when `customer` is not null. */
  loadAddresses?: () => Promise<Addresses>;
  /** Places the editor's parts; without it they render in order: form, message, save. */
  layout?: (parts: { form: ReactNode; message: ReactNode; save: ReactNode }) => ReactNode;
  /** The save button's words; the Customers screen's new-customer form reads v2's "Add Customer". */
  saveLabel?: string;
}) {
  const [values, setValues] = useState<CustomerFormValues>({ firstName: customer?.firstName ?? '',
    lastName: customer?.lastName ?? '', email: customer?.email ?? '', phone: customer?.phone ?? '', address: '' });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [stored, setStored] = useState(customer && !loadAddresses ? customer.billing : undefined);
  const [fields, setFields] = useState(() => billingFields(stored));
  const [storedShipping, setStoredShipping] = useState(customer && !loadAddresses ? customer.shipping : undefined);
  const [shippingFields, setShippingFields] = useState(() => billingFields(storedShipping));
  const [sameAsBilling, setSameAsBilling] = useState(() => shippingIsBilling({ billing: stored, shipping: storedShipping }));
  const [billingStatus, setBillingStatus] = useState(customer && loadAddresses ? 'loading' : 'ready');
  const countryValid = billingCountryValid(fields);
  const shippingCountryValid = sameAsBilling || billingCountryValid(shippingFields);
  useEffect(() => {
    if (!customer || !loadAddresses) return;
    let live = true; // a load that settles after the editor closes changes nothing
    void loadAddresses().then((addresses) => {
      if (!live) return;
      setStored(addresses.billing);
      setFields(billingFields(addresses.billing));
      setStoredShipping(addresses.shipping);
      setShippingFields(billingFields(addresses.shipping));
      setSameAsBilling(shippingIsBilling(addresses));
      setBillingStatus('ready');
    }, (error) => {
      if (!live) return;
      setBillingStatus('failed');
      if (error instanceof ConnectorUnauthorizedError && error.code === 'unauthorized') onUnauthorized();
    });
    return () => { live = false; };
  }, []);
  async function submit() {
    if (saving || values.email.trim() === '' || !countryValid || !shippingCountryValid) return;
    setSaving(true);
    setMessage(null);
    try {
      const namesBase = { ...(values.firstName.trim() ? { firstName: values.firstName.trim() } : {}),
        ...(values.lastName.trim() ? { lastName: values.lastName.trim() } : {}) };
      const billingWrite = customer ? billingStatus === 'ready' && billingChanged(fields, stored) : hasBilling(fields);
      const billingValue = billingAddress(fields, stored ?? namesBase);
      // Same as billing: with no stored shipping the billing address stands for both; otherwise shipping follows billing.
      const shipping = billingStatus !== 'ready' ? undefined
        : sameAsBilling ? (storedShipping && (billingWrite || billingChanged(fields, storedShipping)) ? billingValue : undefined)
          : (customer ? billingChanged(shippingFields, storedShipping) : hasBilling(shippingFields))
            ? billingAddress(shippingFields, storedShipping ?? namesBase) : undefined;
      await save(values, billingWrite ? billingValue : undefined, shipping);
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
  const form = <>
    <CustomerForm values={values} onChangeField={(field, value) => setValues((current) => ({ ...current, [field]: value }))}
      showAddress={false} />
    <View className="gap-3 p-4">
      <Text className="text-sm font-medium text-foreground">Billing address</Text>
      <AddressGrid fields={fields} disabled={billingStatus !== 'ready'} countryTestID="customer-billing-country"
        onChange={(field, value) => setFields((current) => ({ ...current, [field]: value }))} />
      {billingStatus === 'failed' && <Text className="text-sm text-muted-foreground">{BILLING_LOAD_FAILED}</Text>}
      {!countryValid && <Text className="text-sm text-destructive">{BILLING_COUNTRY_HINT}</Text>}
    </View>
    <View className="gap-3 p-4">
      <Text className="text-sm font-medium text-foreground">Shipping address</Text>
      {sameAsBilling ? <>
        <Text className="text-sm text-muted-foreground">Same as billing</Text>
        <Button variant="outline" className="self-start" testID="customer-shipping-different"
          disabled={billingStatus !== 'ready'} onPress={() => setSameAsBilling(false)}>
          <Text>Use a different address</Text>
        </Button>
      </> : <>
        <AddressGrid fields={shippingFields} disabled={billingStatus !== 'ready'} labelPrefix="Shipping"
          countryTestID="customer-shipping-country"
          onChange={(field, value) => setShippingFields((current) => ({ ...current, [field]: value }))} />
        {!shippingCountryValid && <Text className="text-sm text-destructive">{SHIPPING_COUNTRY_HINT}</Text>}
        <Button variant="link" className="self-start" testID="customer-shipping-same"
          disabled={billingStatus !== 'ready'} onPress={() => setSameAsBilling(true)}>
          <Text>Same as billing</Text>
        </Button>
      </>}
    </View>
  </>;
  const shown = message ? <Text accessibilityRole="alert" className="text-sm text-destructive">{message}</Text> : null;
  const saveButton = <Button testID="customer-save" disabled={saving || values.email.trim() === '' || !countryValid || !shippingCountryValid}
    onPress={submit}>
    <Text>{saveLabel}</Text>
  </Button>;
  return layout ? <>{layout({ form, message: shown, save: saveButton })}</> : <>{form}{shown}{saveButton}</>;
}

/**
 * The address inputs, in rows. With `labelPrefix` (e.g. "Shipping") each input's accessibility label starts with it,
 * so two grids on one form stay apart; the visible labels are the same. `countryTestID` prefixes the picker's testIDs.
 */
function AddressGrid({ fields, onChange, disabled, labelPrefix, countryTestID }: { fields: BillingFields;
  onChange: (field: keyof BillingFields, value: string) => void; disabled: boolean; labelPrefix?: string; countryTestID: string }) {
  const named = (label: string) => labelPrefix ? `${labelPrefix} ${label.toLowerCase()}` : label;
  return <>{([[['address1', 'Address line 1']], [['address2', 'Address line 2']],
    [['city', 'City'], ['state', 'State / province']], [['postcode', 'Postal code'], ['country', 'Country']]] as const
  ).map((row) => <View key={row[0][0]} className="flex-row gap-3">
    {row.map(([field, label]) => <View key={field} className="flex-1 gap-1">
      <Text className="text-xs font-medium text-muted-foreground">{label}</Text>
      {field === 'country'
        ? <CountryPicker value={fields.country} disabled={disabled} testID={countryTestID} accessibilityLabel={named(label)}
          onChange={(country) => onChange('country', country)} />
        : <TextInput accessibilityLabel={named(label)} value={fields[field]} editable={!disabled}
          onChangeText={(value) => onChange(field, value)}
          className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground"
          placeholderTextColorClassName="accent-muted-foreground" />}
    </View>)}
  </View>)}</>;
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
 * Picks a country by name from every ISO 3166-1 country; the value is the stored code. A stored code
 * that is not in the list is shown as it is, so opening the form never changes it. Matches sit under the field.
 */
function CountryPicker({ value, disabled, onChange, testID, accessibilityLabel }: { value: string; disabled: boolean;
  onChange: (code: string) => void; testID: string; accessibilityLabel: string }) {
  const shown = (code: string) => countryName(code) ?? code;
  const [text, setText] = useState(() => shown(value));
  const [editing, setEditing] = useState(false);
  useEffect(() => { setText(shown(value)); setEditing(false); }, [value]);
  const matches = countryMatches(text);
  const pick = (code: string) => { onChange(code); setText(shown(code)); setEditing(false); };
  return <>
    <TextInput testID={testID} accessibilityLabel={accessibilityLabel} value={text} editable={!disabled}
      placeholder="Type a country" onBlur={() => { setText(shown(value)); setEditing(false); }}
      onChangeText={(next) => { setText(next); setEditing(next !== ''); if (next === '') onChange(''); }}
      onSubmitEditing={() => { if (matches[0]) pick(matches[0].code); }}
      className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground"
      placeholderTextColorClassName="accent-muted-foreground" />
    {!disabled && editing && <View testID={`${testID}-matches`} {...keepFieldFocus}
      className="rounded-lg border border-border bg-card py-1">
      {matches.length === 0 ? <Text className="px-3 py-2 text-sm text-muted-foreground">No matching country</Text>
        : matches.map((country) => <Pressable key={country.code} testID={`${testID}-${country.code}`}
          accessibilityRole="button" onPress={() => pick(country.code)} className="px-3 py-2">
          <Text className="text-sm text-foreground">{country.name}</Text>
        </Pressable>)}
    </View>}
  </>;
}
