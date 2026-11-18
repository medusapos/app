import { useEffect, useState } from 'react';
import { ScrollView } from 'react-native';
import { Dialog, DialogContent, DialogTitle, Text } from '@tallyui/components';
import { ConnectorUnauthorizedError, type Customer, type CustomerAddress, type CustomerPatch } from '@tallyui/core';
import { CustomerEditor } from './customer-editor';
import { saveCustomerEdits } from '../lib/save-customer-edits';

export const CUSTOMER_LOADING = 'Loading customer…';
export const CUSTOMER_GONE = 'This customer is no longer in the store.';
export const CUSTOMER_LOAD_FAILED = "Couldn't load this customer. Check the connection and try again.";

/**
 * v2's cart chip map pin (DEMO-PARITY row 04a.2): the cart customer in the Customers area's editor. Medusa keeps addresses
 * on the customer, so saving updates the customer record and its default billing/shipping addresses.
 */
export function CustomerAddressDialog({ customerId, onClose, getCustomer, loadAddresses, update, onSaved, onUnauthorized }: {
  customerId: string | null;
  onClose: () => void;
  getCustomer: (id: string) => Promise<Customer | null>;
  loadAddresses: (id: string) => Promise<{ billing?: CustomerAddress; shipping?: CustomerAddress }>;
  update: (id: string, patch: CustomerPatch) => Promise<Customer>;
  onSaved: (customer: Customer) => void;
  onUnauthorized: () => void;
}) {
  const [loaded, setLoaded] = useState<{ id: string; customer: Customer | null | 'failed' } | null>(null);
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
  return <Dialog open={customerId !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent testID="customer-address-dialog" className="max-h-[90%]">
      <DialogTitle>Edit customer address</DialogTitle>
      <ScrollView keyboardShouldPersistTaps="handled">
        {customer === undefined ? <Text className="p-4 text-sm text-muted-foreground">{CUSTOMER_LOADING}</Text>
          : customer === null ? <Text className="p-4 text-sm text-muted-foreground">{CUSTOMER_GONE}</Text>
            : customer === 'failed' ? <Text accessibilityRole="alert" className="p-4 text-sm text-destructive">{CUSTOMER_LOAD_FAILED}</Text>
              : <CustomerEditor key={customer.id} customer={customer} onUnauthorized={onUnauthorized}
                loadAddresses={() => loadAddresses(customer.id)} save={async (values, billing, shipping) => {
                  const updated = await saveCustomerEdits(update, customer, values, billing, shipping);
                  if (updated) onSaved(updated);
                  onClose();
                }} />}
      </ScrollView>
    </DialogContent>
  </Dialog>;
}
