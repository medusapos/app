import { useRef } from 'react';
import { ScrollView } from 'react-native';
import { Dialog, DialogContent, DialogTitle } from '@tallyui/components';
import type { Customer, CustomerInput, CustomerPatch } from '@tallyui/core';
import { CustomerEditor } from './customer-editor';
import { saveNewCustomer } from '../lib/save-new-customer';

/** v2's cart "+" menu "Add new customer": the Customers screen's new-customer form in a dialog. */
export function NewCustomerDialog({ open, onOpenChange, create, update, onSaved, onUnauthorized }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  create: (input: CustomerInput) => Promise<Customer>;
  update?: (id: string, patch: CustomerPatch) => Promise<Customer>;
  onSaved: (customer: Customer) => void;
  onUnauthorized: () => void;
}) {
  const created = useRef<Customer | null>(null);
  return <Dialog open={open} onOpenChange={(next) => { if (!next) created.current = null; onOpenChange(next); }}>
    <DialogContent testID="new-customer-dialog" className="max-h-[90%]">
      <DialogTitle>Add new customer</DialogTitle>
      <ScrollView keyboardShouldPersistTaps="handled">
        {open && <CustomerEditor customer={null} onUnauthorized={onUnauthorized} save={async (values, billing, shipping) => {
          await saveNewCustomer({ create, update }, values, billing, shipping, created, onSaved);
          created.current = null;
          onOpenChange(false);
        }} />}
      </ScrollView>
    </DialogContent>
  </Dialog>;
}
