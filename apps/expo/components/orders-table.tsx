import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, Text } from 'react-native';
import {
  Button, OrderStatusBadge, OrderSyncNotices, orderReference, Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
  Text as TableText,
} from '@tallyui/components';
import type { StoreOrder } from '@tallyui/core';
import type { PosOrder, UseOrderOutboxResult } from '@tallyui/pos';
import { orderStatusBadge } from '../lib/order-detail';
import { ordersTableCells, storeOrderTableCells } from '../lib/orders-table';
import type { OrdersRow } from '../lib/store-orders';

const HEADS = ['Status', 'Order Number', 'Customer', 'Date Created', 'Cashier', 'Payment Method', 'Total'];

// v2's Orders table: a row opens the sale. With `onRetry` (the attention table only) each row is followed by a
// full-width row of TallyUI's OrderSyncNotices, which says why the sale needs attention and holds Retry, as OrdersList does.
// `rows` mixes the till's sales with orders only the store has; `orders` lists the till's sales alone.
export function OrdersTable({ orders, rows, testID, rowTestID = `${testID}-row`, formatDate, onOpen, onOpenStore, onRetry, stuck }: {
  orders?: PosOrder[]; rows?: OrdersRow[]; testID: string; rowTestID?: string; formatDate: (iso: string) => string;
  onOpen: (id: string) => void; onOpenStore?: (order: StoreOrder) => void;
  onRetry?: (orderIds: string[]) => Promise<number>; stuck?: UseOrderOutboxResult['state']['stuck'];
}) {
  const items = useMemo<OrdersRow[]>(() => rows ?? (orders ?? []).map((order) => ({ kind: 'local', key: order.id, order })),
    [rows, orders]);
  // The ref stops a second press before React re-renders; the state disables the button.
  const retrying = useRef(new Set<string>());
  const [retryingIds, setRetryingIds] = useState(new Set<string>());
  useEffect(() => {
    for (const id of retrying.current) {
      if (!items.some(({ kind, order }) => kind === 'local' && order.id === id && order.syncStatus === 'rejected')) {
        retrying.current.delete(id);
      }
    }
    setRetryingIds(new Set(retrying.current));
  }, [items]);
  if (items.length === 0) return null;
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
      <TableBody>{items.map((item) => {
        const row = `${rowTestID}-${item.key}`;
        const cells = item.kind === 'local'
          ? { ...ordersTableCells(item.order), status: orderStatusBadge(item.order), number: orderReference(item.order),
            date: item.order.createdAt }
          : { ...storeOrderTableCells(item.order), retryable: false };
        const notices = onRetry && item.kind === 'local' ? item.order : null;
        const muted = (value: string) => value === '—' ? 'text-muted-foreground' : 'text-foreground';
        return <Fragment key={item.key}>
          {/* The notices row below carries the line under an attention row. */}
          <TableRow testID={row} className={notices ? 'border-b-0' : undefined}>
            <Pressable accessibilityRole="button" accessibilityLabel={`Open order ${cells.number}`}
              onPress={() => item.kind === 'local' ? onOpen(item.order.id) : onOpenStore?.(item.order)} className="flex-1 flex-row">
              <TableCell testID={`${row}-status`}><OrderStatusBadge status={cells.status} /></TableCell>
              <TableCell testID={`${row}-number`}><Text className="text-foreground">{cells.number}</Text></TableCell>
              <TableCell testID={`${row}-customer`}><Text className="text-foreground">{cells.customer}</Text></TableCell>
              <TableCell testID={`${row}-date`}><Text className="text-foreground">{formatDate(cells.date)}</Text></TableCell>
              <TableCell testID={`${row}-cashier`}><Text className={muted(cells.cashier)}>{cells.cashier}</Text></TableCell>
              <TableCell testID={`${row}-payment`}><Text className={muted(cells.payment)}>{cells.payment}</Text></TableCell>
              <TableCell testID={`${row}-total`} className="items-end tabular-nums">
                <Text className="text-right tabular-nums text-foreground">{cells.total}</Text>
              </TableCell>
              <TableCell className="w-10 flex-none items-end"><Text className="text-muted-foreground">›</Text></TableCell>
            </Pressable>
          </TableRow>
          {notices ? <TableRow testID={`${row}-notices`}>
            <TableCell className="gap-1 pt-0">
              <OrderSyncNotices order={notices} stuck={stuck}>
                {cells.retryable ? <Button size="sm" testID={`${row}-retry`} accessibilityLabel="Retry" className="self-start"
                  disabled={retryingIds.has(notices.id)} onPress={() => { void retry(notices.id); }}>
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
