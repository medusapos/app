import { Pressable, ScrollView, Text, View } from 'react-native';
import {
  Avatar, avatarInitials, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Text as TableText,
} from '@tallyui/components';
import type { Customer } from '@tallyui/core';

// v2's customers table; Billing address and Date created wait until the connector's search returns them.
export function CustomersTable({ customers, onOpen }: { customers: Customer[]; onOpen?: (customer: Customer) => void }) {
  if (customers.length === 0) return null;
  return <ScrollView horizontal contentContainerClassName="grow">
    <Table testID="customers-table" className="min-w-[720px] w-full">
      <TableHeader><TableRow>
        <TableHead className="w-16 flex-none" />
        <TableHead><TableText>First name</TableText></TableHead>
        <TableHead><TableText>Last name</TableText></TableHead>
        <TableHead className="flex-[2]"><TableText>Email</TableText></TableHead>
        {onOpen ? <TableHead className="w-10 flex-none" /> : null}
      </TableRow></TableHeader>
      <TableBody>{customers.map((customer) => {
        const props = { testID: `customer-row-${customer.id}`, className: 'flex-1 flex-row items-center',
          accessibilityLabel: [customer.name, customer.email, customer.phone].filter(Boolean).join(', ') };
        const cell = `customer-cell-${customer.id}`;
        const cells = <>
          <TableCell className="w-16 flex-none justify-center">
            <Avatar fallback={avatarInitials(customer.name)} tone="primary" />
          </TableCell>
          <TableCell testID={`${cell}-first`}><Text className="text-foreground">{customer.firstName ?? ''}</Text></TableCell>
          <TableCell testID={`${cell}-last`}><Text className="text-foreground">{customer.lastName ?? ''}</Text></TableCell>
          <TableCell testID={`${cell}-email`} className="flex-[2]"><Text className="text-foreground">{customer.email ?? ''}</Text></TableCell>
          {onOpen ? <TableCell className="w-10 flex-none items-end"><Text className="text-muted-foreground">›</Text></TableCell> : null}
        </>;
        return <TableRow key={customer.id}>
          {onOpen
            ? <Pressable {...props} accessibilityRole="button" onPress={() => onOpen(customer)}>{cells}</Pressable>
            : <View {...props}>{cells}</View>}
        </TableRow>;
      })}</TableBody>
    </Table>
  </ScrollView>;
}
