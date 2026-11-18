import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { AppText as Text } from '../components/app-text';
import { Redirect, Stack } from 'expo-router';
import { Path } from 'react-native-svg';
import { createSvgIcon, Dialog, DialogContent, DialogTitle, IconButton, SearchInput } from '@tallyui/components';
import { ConnectorUnauthorizedError, CustomerServiceError, type Customer, type SyncContext } from '@tallyui/core';
import { AreaAccountButton, FrameMenuButton, useFrameMenu } from '../components/app-frame';
import { CustomerColumnsButton } from '../components/customer-columns-settings';
import { CustomerEditor, NETWORK_ERROR_TEXT } from '../components/customer-editor';
import { CustomersTable } from '../components/customers-table';
import { StripHeightContext } from '../components/store-refused';
import { loadCustomerAddresses } from '../lib/customer-billing';
import { useCustomerColumns } from '../lib/customer-columns';
import { saveCustomerEdits } from '../lib/save-customer-edits';
import { saveNewCustomer } from '../lib/save-new-customer';
import { authHeaders, createPosConnector } from '../lib/pos-connector';
import { useSession } from '../lib/session-context';
import { defaultStorage, type Session } from '../lib/session';

export const SEARCH_HINT = 'Search by name, email or phone.';
export const SEARCHING_TEXT = 'Searching…';
export const NO_MATCH_TEXT = (query: string) => `No customers match “${query}”.`;
export { NETWORK_ERROR_TEXT };
export const SEARCH_ERROR_TEXT = "Couldn't search customers. Try again.";

// v2's add-customer glyph, tabler's `user-plus`.
const UserPlusIcon = createSvgIcon('UserPlusIcon', () => <><Path d="M8 7a4 4 0 1 0 8 0a4 4 0 0 0 -8 0" />
  <Path d="M16 19h6" /><Path d="M19 16v6" /><Path d="M6 21v-2a4 4 0 0 1 4 -4h4" /></>);

export default function CustomersScreen() {
  const { session, reportUnauthorized } = useSession();
  // v2's Customers has no title bar on a wide window; a phone keeps the header for the drawer's Menu.
  const openMenu = useFrameMenu();
  if (!session) return <Redirect href="/login" />;
  return <>
    <Stack.Screen options={{ title: 'Customers', headerShown: !!openMenu, headerLeft: () => <FrameMenuButton />, headerRight: () => <View className="pr-4"><AreaAccountButton /></View> }} />
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
  const columns = useCustomerColumns(defaultStorage(), session.baseUrl);
  // Without a header the sign-in / refused strip lies over the top of the screen (as on the Sale screen).
  const topInset = useContext(StripHeightContext);
  const openMenu = useFrameMenu();

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
  return <View className="flex-1 bg-background" role="main" aria-label="Customers">
    <View className="flex-row items-center gap-2 px-4 pb-2" style={{ paddingTop: 16 + topInset }}>
      <SearchInput className="flex-1" value={query} onChangeText={setQuery} placeholder="Search customers"
        accessibilityLabel="Search customers" testID="customers-search" autoFocus />
      {connector.createCustomer && <IconButton testID="customers-add" accessibilityLabel="Add customer"
        onPress={() => { createdCustomer.current = null; setEditing('new'); }}><UserPlusIcon /></IconButton>}
      <CustomerColumnsButton {...columns} />
      {!openMenu && <AreaAccountButton />}
    </View>
    {message ? <View className="flex-1 items-center justify-center">
      <Text className="text-sm text-muted-foreground" accessibilityRole={failed ? 'alert' : undefined}>{message}</Text>
    </View> : <ScrollView>
      <CustomersTable customers={customers} columns={columns.settings} onOpen={connector.updateCustomer ? (customer) => { createdCustomer.current = null; setEditing(customer); } : undefined} />
    </ScrollView>}
    <Dialog open={editing !== null} onOpenChange={(open) => { if (!open) { createdCustomer.current = null; setEditing(null); } }}>
      <DialogContent testID="customer-editor" className="max-h-[90%]">
        <DialogTitle>{editing === 'new' ? 'New customer' : 'Edit customer'}</DialogTitle>
        <ScrollView keyboardShouldPersistTaps="handled">
        {editing !== null && <CustomerEditor key={editing === 'new' ? 'new' : editing.id}
          loadAddresses={editing === 'new' ? undefined : () => loadCustomerAddresses(context, editing.id)}
          customer={editing === 'new' ? null : editing} onUnauthorized={onUnauthorized} save={async (values, billing, shipping) => {
            if (editing === 'new') {
              await saveNewCustomer({ create: (input) => connector.createCustomer!(context, input),
                update: connector.updateCustomer && ((id, patch) => connector.updateCustomer!(context, id, patch)) },
                values, billing, shipping, createdCustomer, (saved) => {
                setCustomers((list) => list.some((customer) => customer.id === saved.id)
                  ? list.map((customer) => customer.id === saved.id ? saved : customer) : [saved, ...list]);
                setMessage(null);
                setFailed(false);
              });
            } else {
              const updated = await saveCustomerEdits((id, patch) => connector.updateCustomer!(context, id, patch),
                editing, values, billing, shipping);
              if (updated) setCustomers((list) => list.map((customer) => customer.id === editing.id ? updated : customer));
            }
            createdCustomer.current = null;
            setEditing(null);
          }} />}
        </ScrollView>
      </DialogContent>
    </Dialog>
  </View>;
}
