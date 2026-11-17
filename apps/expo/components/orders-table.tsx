import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, Text } from 'react-native';
import {
  Button, OrderStatusBadge, orderReference, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Text as TableText,
} from '@tallyui/components';
import type { PosOrder } from '@tallyui/pos';
import { orderStatusBadge } from '../lib/order-detail';
import { ordersTableCells } from '../lib/orders-table';

const HEADS = ['Status', 'Order Number', 'Customer', 'Date Created', 'Cashier', 'Payment Method', 'Total'];

// v2's Orders table: a row opens the sale; Retry (attention table only) sits outside the row's open button.
export function OrdersTable({ orders, testID, formatDate, onOpen, onRetry }: {
  orders: PosOrder[]; testID: string; formatDate: (iso: string) => string; onOpen: (id: string) => void;
  onRetry?: (orderIds: string[]) => Promise<number>;
}) {
  // The ref stops a second press before React re-renders; the state disables the button.
  const retrying = useRef(new Set<string>());
  const [retryingIds, setRetryingIds] = useState(new Set<string>());
  useEffect(() => {
    for (const id of retrying.current) {
      if (!orders.some((order) => order.id === id && order.syncStatus === 'rejected')) retrying.current.delete(id);
    }
    setRetryingIds(new Set(retrying.current));
  }, [orders]);
  if (orders.length === 0) return null;
  const retry = async (id: string) => {
    if (!onRetry || retrying.current.has(id)) return;
    retrying.current.add(id);
    setRetryingIds(new Set(retrying.current));
    const requeued = await onRetry([id]).catch(() => 0);
    if (requeued === 0) {
      retrying.current.delete(id);
      setRetryingIds(new Set(retrying.current));
    }
  };
  return <ScrollView horizontal contentContainerClassName="grow">
    <Table testID={testID} className="min-w-[960px] w-full">
      <TableHeader><TableRow>
        {HEADS.map((label) => <TableHead key={label} className={label === 'Total' ? 'items-end' : undefined}>
          <TableText className={label === 'Total' ? 'text-right' : undefined}>{label}</TableText>
        </TableHead>)}
        <TableHead className="w-10 flex-none" />
        {onRetry ? <TableHead className="w-24 flex-none" /> : null}
      </TableRow></TableHeader>
      <TableBody>{orders.map((order) => {
        const row = `${testID}-row-${order.id}`;
        const cells = ordersTableCells(order);
        const reference = orderReference(order);
        const muted = (value: string) => value === '—' ? 'text-muted-foreground' : 'text-foreground';
        return <TableRow key={order.id} testID={row}>
          <Pressable accessibilityRole="button" accessibilityLabel={`Open order ${reference}`}
            onPress={() => onOpen(order.id)} className="flex-1 flex-row">
            <TableCell testID={`${row}-status`}><OrderStatusBadge status={orderStatusBadge(order)} /></TableCell>
            <TableCell testID={`${row}-number`}><Text className="text-foreground">{reference}</Text></TableCell>
            <TableCell testID={`${row}-customer`}><Text className="text-foreground">{cells.customer}</Text></TableCell>
            <TableCell testID={`${row}-date`}><Text className="text-foreground">{formatDate(order.createdAt)}</Text></TableCell>
            <TableCell testID={`${row}-cashier`}><Text className={muted(cells.cashier)}>{cells.cashier}</Text></TableCell>
            <TableCell testID={`${row}-payment`}><Text className={muted(cells.payment)}>{cells.payment}</Text></TableCell>
            <TableCell testID={`${row}-total`} className="items-end tabular-nums">
              <Text className="text-right tabular-nums text-foreground">{cells.total}</Text>
            </TableCell>
            <TableCell className="w-10 flex-none items-end"><Text className="text-muted-foreground">›</Text></TableCell>
          </Pressable>
          {onRetry ? <TableCell className="w-24 flex-none">
            {cells.retryable ? <Button size="sm" testID={`${row}-retry`} accessibilityLabel="Retry"
              disabled={retryingIds.has(order.id)} onPress={() => { void retry(order.id); }}>
              <TableText>Retry</TableText>
            </Button> : null}
          </TableCell> : null}
        </TableRow>;
      })}</TableBody>
    </Table>
  </ScrollView>;
}
