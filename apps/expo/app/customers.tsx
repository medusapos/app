import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { AppText as Text } from '../components/app-text';
import { Redirect, Stack } from 'expo-router';
import { Avatar, avatarInitials, Button, Dialog, DialogContent, DialogTitle, SearchInput, Text as ButtonText } from '@tallyui/components';
import { ConnectorUnauthorizedError, CustomerServiceError, type Customer, type CustomerPatch, type SyncContext } from '@tallyui/core';
import { FrameMenuButton } from '../components/app-frame';
import { CustomerEditor, NETWORK_ERROR_TEXT } from '../components/customer-editor';
import { BillingNotSavedError, loadCustomerBilling } from '../lib/customer-billing';
import { authHeaders, createPosConnector } from '../lib/pos-connector';
import { useSession } from '../lib/session-context';
import type { Session } from '../lib/session';

export const SEARCH_HINT = 'Search by name, email or phone.';
export const SEARCHING_TEXT = 'Searching…';
export const NO_MATCH_TEXT = (query: string) => `No customers match “${query}”.`;
export { NETWORK_ERROR_TEXT };
export const SEARCH_ERROR_TEXT = "Couldn't search customers. Try again.";

export default function CustomersScreen() {
  const { session, reportUnauthorized } = useSession();
  if (!session) return <Redirect href="/login" />;
  return <>
    <Stack.Screen options={{ title: 'Customers', headerLeft: () => <FrameMenuButton /> }} />
    <CustomersSearch session={session} onUnauthorized={reportUnauthorized} />
  </>;
}

function CustomersSearch({ session, onUnauthorized }: { session: Session; onUnauthorized: () => void }) {
  const connector = useMemo(() => createPosConnector(), []);
  const context = useMemo<SyncContext>(() => ({ connectorId: connector.id, baseUrl: session.baseUrl,
    headers: authHeaders(session.token) }), [connector.id, session.baseUrl, session.token]);
  const [query, setQuery] = useState('');
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [message, setMessage] = useState<string | null>(SEARCH_HINT);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState<Customer | 'new' | null>(null);
  const request = useRef(0);
  const createdCustomer = useRef<Customer | null>(null);

  useEffect(() => {
    const current = ++request.current;
    setCustomers([]);
    setFailed(false);
    setMessage(query.trim() ? SEARCHING_TEXT : SEARCH_HINT);
    const searchCustomers = connector.searchCustomers;
    if (!query.trim() || !searchCustomers) return;
    const timer = setTimeout(async () => {
      try {
        const answer = await searchCustomers(context, query.trim(), { limit: 50 });
        if (current !== request.current) return;
        setCustomers(answer);
        setMessage(answer.length ? null : NO_MATCH_TEXT(query));
      } catch (error) {
        if (current !== request.current) return;
        if (error instanceof ConnectorUnauthorizedError && error.code === 'unauthorized') {
          onUnauthorized();
          return;
        }
        setFailed(true);
        setMessage(error instanceof CustomerServiceError && error.code === 'network' ? NETWORK_ERROR_TEXT : SEARCH_ERROR_TEXT);
      }
    }, 250);
    return () => { clearTimeout(timer); ++request.current; };
  }, [connector, context, query, onUnauthorized]);

  if (!connector.searchCustomers) return <Text>Customers aren't available for this store.</Text>;
  return <View className="flex-1 bg-background">
    <View className="flex-row items-center gap-2 px-4 pt-4 pb-2">
      <SearchInput className="flex-1" value={query} onChangeText={setQuery} placeholder="Search customers"
        accessibilityLabel="Search customers" testID="customers-search" autoFocus />
      {connector.createCustomer && <Button variant="outline" testID="customers-add" onPress={() => { createdCustomer.current = null; setEditing('new'); }}>
        <ButtonText>Add customer</ButtonText>
      </Button>}
    </View>
    {message ? <View className="flex-1 items-center justify-center">
      <Text className="text-sm text-muted-foreground" accessibilityRole={failed ? 'alert' : undefined}>{message}</Text>
    </View> : <ScrollView>
      {customers.map((customer) => {
        const props = { testID: `customer-row-${customer.id}`,
          accessibilityLabel: [customer.name, customer.email, customer.phone].filter(Boolean).join(', '),
          className: 'min-h-14 flex-row items-center gap-3 border-b border-border px-4 py-2' };
        const children = <>
          <Avatar fallback={avatarInitials(customer.name)} tone="primary" />
          <View className="flex-1">
            <Text className="text-foreground font-medium">{customer.name}</Text>
            {customer.email ? <Text className="text-sm text-muted-foreground">{customer.email}</Text> : null}
            {customer.phone ? <Text className="text-sm text-muted-foreground">{customer.phone}</Text> : null}
          </View>
        </>;
        return connector.updateCustomer
          ? <Pressable key={customer.id} {...props} accessibilityRole="button" onPress={() => { createdCustomer.current = null; setEditing(customer); }}>{children}</Pressable>
          : <View key={customer.id} {...props}>{children}</View>;
      })}
    </ScrollView>}
    <Dialog open={editing !== null} onOpenChange={(open) => { if (!open) { createdCustomer.current = null; setEditing(null); } }}>
      <DialogContent testID="customer-editor" className="max-h-[90%]">
        <DialogTitle>{editing === 'new' ? 'New customer' : 'Edit customer'}</DialogTitle>
        <ScrollView>
        {editing !== null && <CustomerEditor key={editing === 'new' ? 'new' : editing.id}
          loadBilling={editing === 'new' ? undefined : () => loadCustomerBilling(context, editing.id)}
          customer={editing === 'new' ? null : editing} onUnauthorized={onUnauthorized} save={async (values, billing) => {
            if (editing === 'new') {
              const patch: CustomerPatch = {};
              if (createdCustomer.current) {
                for (const field of ['firstName', 'lastName', 'email', 'phone'] as const) {
                  if (values[field].trim() !== (createdCustomer.current[field] ?? '')) patch[field] = values[field].trim();
                }
              }
              const input = { email: values.email.trim(),
                ...(values.firstName.trim() ? { firstName: values.firstName.trim() } : {}),
                ...(values.lastName.trim() ? { lastName: values.lastName.trim() } : {}),
                ...(values.phone.trim() ? { phone: values.phone.trim() } : {}) };
              const created = createdCustomer.current ?? await connector.createCustomer!(context, input);
              createdCustomer.current = created;
              setCustomers((list) => list.some((customer) => customer.id === created.id)
                ? list.map((customer) => customer.id === created.id ? created : customer) : [created, ...list]);
              setMessage(null);
              setFailed(false);
              if ((Object.keys(patch).length || billing !== undefined) && connector.updateCustomer) {
                try {
                  const updated = await connector.updateCustomer(context, created.id, { ...patch, ...(billing !== undefined ? { billing } : {}) });
                  createdCustomer.current = updated;
                  setCustomers((list) => list.map((customer) => customer.id === created.id ? updated : customer));
                } catch (error) { throw new BillingNotSavedError(created, error); }
              }
            } else {
              const patch: CustomerPatch = {};
              for (const field of ['firstName', 'lastName', 'email', 'phone'] as const) {
                if (values[field].trim() !== (editing[field] ?? '')) patch[field] = values[field].trim();
              }
              if (billing !== undefined) patch.billing = billing;
              if (Object.keys(patch).length) {
                const updated = await connector.updateCustomer!(context, editing.id, patch);
                setCustomers((list) => list.map((customer) => customer.id === editing.id ? updated : customer));
              }
            }
            createdCustomer.current = null;
            setEditing(null);
          }} />}
        </ScrollView>
      </DialogContent>
    </Dialog>
  </View>;
}
