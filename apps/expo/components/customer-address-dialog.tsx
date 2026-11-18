import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { Button, Dialog, DialogContent, DialogTitle, IconButton, Text, XIcon } from '@tallyui/components';
import { ConnectorUnauthorizedError, type Customer, type CustomerAddress, type CustomerPatch } from '@tallyui/core';
import { CustomerEditor } from './customer-editor';
import { saveCustomerEdits } from '../lib/save-customer-edits';
import { sheetEdge, sheetEdgeClass } from '../lib/sheet-edge';

export const CUSTOMER_LOADING = 'Loading customer…';
export const CUSTOMER_GONE = 'This customer is no longer in the store.';
export const CUSTOMER_LOAD_FAILED = "Couldn't load this customer. Check the connection and try again.";

/**
 * v2's cart chip map pin (DEMO-PARITY row 04a.2): the cart customer in the Customers area's editor. Medusa keeps addresses
 * on the customer, so saving updates the customer record and its default billing/shipping addresses. As in v2 it is a side
 * sheet over the products, away from the cart, with a ✕ and a Close / Save footer.
 */
export function CustomerAddressDialog({ customerId, onClose, getCustomer, loadAddresses, update, onSaved, onUnauthorized,
  cartSide, phone }: {
  customerId: string | null;
  onClose: () => void;
  getCustomer: (id: string) => Promise<Customer | null>;
  loadAddresses: (id: string) => Promise<{ billing?: CustomerAddress; shipping?: CustomerAddress }>;
  update: (id: string, patch: CustomerPatch) => Promise<Customer>;
  onSaved: (customer: Customer) => void;
  onUnauthorized: () => void;
  cartSide: 'left' | 'right';
  phone: boolean;
}) {
  const [loaded, setLoaded] = useState<{ id: string; customer: Customer | null | 'failed' } | null>(null);
  const currentId = useRef(customerId); // the save outlives its render, so it reads the dialog's customer now
  currentId.current = customerId;
  useEffect(() => {
    setLoaded(null);
    if (customerId === null) return;
    let live = true; // a result that arrives after the dialog closed or moved to another customer changes nothing
    getCustomer(customerId).then((customer) => { if (live) setLoaded({ id: customerId, customer }); }, (error) => {
      if (!live) return;
      setLoaded({ id: customerId, customer: 'failed' });
      if (error instanceof ConnectorUnauthorizedError && error.code === 'unauthorized') onUnauthorized();
    });
    return () => { live = false; };
  }, [customerId]);
  const customer = loaded && loaded.id === customerId ? loaded.customer : undefined;
  const edge = sheetEdge(cartSide, phone);
  // The scrolling body, a failed save's message above the footer, and the footer: Close, then Save once the editor shows.
  const parts = ({ form, message = null, save = null }: { form: ReactNode; message?: ReactNode; save?: ReactNode }) => <>
    <ScrollView className="flex-1" keyboardShouldPersistTaps="handled">{form}</ScrollView>
    {message}
    <View testID="customer-address-footer" className="flex-row justify-end gap-2">
      <Button variant="outline" testID="customer-address-close" onPress={onClose}><Text>Close</Text></Button>
      {save}
    </View>
  </>;
  return <Dialog open={customerId !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent side="right" testID="customer-address-dialog" dataSet={{ side: edge }}
      className={"flex-col gap-4 " + sheetEdgeClass(edge)}>
      <View className="flex-row items-center justify-between">
        <DialogTitle>Edit customer address</DialogTitle>
        <IconButton testID="customer-address-x" accessibilityLabel="Close" className="h-11 w-11" onPress={onClose}>
          <View className="text-foreground"><XIcon size={24} /></View>
        </IconButton>
      </View>
      {customer === undefined ? parts({ form: <Text className="p-4 text-sm text-muted-foreground">{CUSTOMER_LOADING}</Text> })
        : customer === null ? parts({ form: <Text className="p-4 text-sm text-muted-foreground">{CUSTOMER_GONE}</Text> })
          : customer === 'failed' ? parts({ form: <Text accessibilityRole="alert" className="p-4 text-sm text-destructive">{CUSTOMER_LOAD_FAILED}</Text> })
            : <CustomerEditor key={customer.id} customer={customer} onUnauthorized={onUnauthorized} layout={parts}
              loadAddresses={() => loadAddresses(customer.id)} save={async (values, billing, shipping) => {
                const updated = await saveCustomerEdits(update, customer, values, billing, shipping);
                if (currentId.current !== customer.id) return; // settled after the dialog closed or moved on: changes nothing
                if (updated) onSaved(updated);
                onClose();
              }} />}
    </DialogContent>
  </Dialog>;
}
