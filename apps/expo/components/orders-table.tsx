import { Fragment, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, Text } from 'react-native';
import {
  Button, OrderStatusBadge, OrderSyncNotices, orderReference, Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
  Text as TableText,
} from '@tallyui/components';
import type { PosOrder, UseOrderOutboxResult } from '@tallyui/pos';
import { orderStatusBadge } from '../lib/order-detail';
import { ordersTableCells } from '../lib/orders-table';

const HEADS = ['Status', 'Order Number', 'Customer', 'Date Created', 'Cashier', 'Payment Method', 'Total'];

// v2's Orders table: a row opens the sale. With `onRetry` (the attention table only) each row is followed by a
// full-width row of TallyUI's OrderSyncNotices, which says why the sale needs attention and holds Retry, as OrdersList does.
export function OrdersTable({ orders, testID, formatDate, onOpen, onRetry, stuck }: {
  orders: PosOrder[]; testID: string; formatDate: (iso: string) => string; onOpen: (id: string) => void;
  onRetry?: (orderIds: string[]) => Promise<number>; stuck?: UseOrderOutboxResult['state']['stuck'];
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
      </TableRow></TableHeader>
      <TableBody>{orders.map((order) => {
        const row = `${testID}-row-${order.id}`;
        const cells = ordersTableCells(order);
        const reference = orderReference(order);
        const muted = (value: string) => value === '—' ? 'text-muted-foreground' : 'text-foreground';
        return <Fragment key={order.id}>
          {/* The notices row below carries the line under an attention row. */}
          <TableRow testID={row} className={onRetry ? 'border-b-0' : undefined}>
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
          </TableRow>
          {onRetry ? <TableRow testID={`${row}-notices`}>
            <TableCell className="gap-1 pt-0">
              <OrderSyncNotices order={order} stuck={stuck}>
                {cells.retryable ? <Button size="sm" testID={`${row}-retry`} accessibilityLabel="Retry" className="self-start"
                  disabled={retryingIds.has(order.id)} onPress={() => { void retry(order.id); }}>
                  <TableText>Retry</TableText>
                </Button> : null}
              </OrderSyncNotices>
            </TableCell>
          </TableRow> : null}
        </Fragment>;
      })}</TableBody>
    </Table>
  </ScrollView>;
}
