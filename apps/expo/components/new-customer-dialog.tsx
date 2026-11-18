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
  // A save belongs to the opening it started in: each opening gets its own `created` holder (the customer an earlier Save
  // created, so a retry patches it), and a save that settles after the dialog closed reports nothing and leaks nothing.
  const session = useRef<{ current: Customer | null } | null>(null);
  if (!open) session.current = null;
  else if (!session.current) session.current = { current: null };
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent testID="new-customer-dialog" className="max-h-[90%]">
      <DialogTitle>Add new customer</DialogTitle>
      <ScrollView keyboardShouldPersistTaps="handled">
        {open && <CustomerEditor customer={null} onUnauthorized={onUnauthorized} save={async (values, billing, shipping) => {
          const created = session.current!;
          await saveNewCustomer({ create, update }, values, billing, shipping, created, (c) => { if (session.current === created) onSaved(c); });
          if (session.current !== created) return;
          onOpenChange(false);
        }} />}
      </ScrollView>
    </DialogContent>
  </Dialog>;
}
