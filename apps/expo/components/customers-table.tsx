import { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import {
  Avatar, avatarInitials, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Text as TableText,
} from '@tallyui/components';
import type { Customer } from '@tallyui/core';
import { sortProducts, type ProductSort } from '@tallyui/pos';
import { DEFAULT_CUSTOMER_COLUMNS, type CustomerColumnSettings } from '../lib/customer-columns';
import { AppText as Text } from './app-text';

type SortField = 'firstName' | 'lastName' | 'email';
// v2's opening order for the customers table.
export const DEFAULT_CUSTOMER_SORT: ProductSort = { field: 'lastName', dir: 'asc' };

// v2's customers table; Billing address and Date created wait until the connector's search returns them.
export function CustomersTable({ customers, onOpen, columns = DEFAULT_CUSTOMER_COLUMNS }: {
  customers: Customer[]; onOpen?: (customer: Customer) => void; columns?: CustomerColumnSettings;
}) {
  const [sort, setSort] = useState<ProductSort | null>(DEFAULT_CUSTOMER_SORT);
  if (customers.length === 0) return null;
  // Never sort by a column the cashier has hidden.
  const activeSort = sort && columns[sort.field as SortField] ? sort : null;
  const rows = sortProducts(customers, activeSort, (customer, field) => customer[field as SortField]);
  const sortHead = (field: SortField, label: string, className?: string) => {
    const dir = activeSort?.field === field ? activeSort.dir : null;
    return <TableHead className={className} aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none'}>
      <Pressable accessibilityRole="button" accessibilityLabel={`Sort by ${label}`} testID={`customers-sort-${field}`}
        onPress={() => setSort(sort?.field === field ? { field, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { field, dir: 'asc' })}>
        <TableText>{label}{dir === 'asc' ? ' ▲' : dir === 'desc' ? ' ▼' : ''}</TableText>
      </Pressable>
    </TableHead>;
  };
  return <ScrollView horizontal contentContainerClassName="grow">
    <Table testID="customers-table" className="min-w-[720px] w-full">
      <TableHeader><TableRow>
        {columns.avatar ? <TableHead className="w-16 flex-none" /> : null}
        {columns.firstName ? sortHead('firstName', 'First name') : null}
        {columns.lastName ? sortHead('lastName', 'Last name') : null}
        {columns.email ? sortHead('email', 'Email', 'flex-[2]') : null}
        {onOpen ? <TableHead className="w-10 flex-none" /> : null}
      </TableRow></TableHeader>
      <TableBody>{rows.map((customer) => {
        const props = { testID: `customer-row-${customer.id}`, className: 'flex-1 flex-row items-center',
          accessibilityLabel: [customer.name, customer.email, customer.phone].filter(Boolean).join(', ') };
        const cell = `customer-cell-${customer.id}`;
        const cells = <>
          {columns.avatar ? <TableCell className="w-16 flex-none justify-center">
            <Avatar fallback={avatarInitials(customer.name)} tone="primary" />
          </TableCell> : null}
          {columns.firstName ? <TableCell testID={`${cell}-first`}><Text className="text-foreground">{customer.firstName ?? ''}</Text></TableCell> : null}
          {columns.lastName ? <TableCell testID={`${cell}-last`}><Text className="text-foreground">{customer.lastName ?? ''}</Text></TableCell> : null}
          {columns.email ? <TableCell testID={`${cell}-email`} className="flex-[2]"><Text className="text-foreground">{customer.email ?? ''}</Text></TableCell> : null}
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
