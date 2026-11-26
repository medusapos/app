import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import {
  Button, OrderStatusBadge, OrderSyncNotices, orderReference, Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
  Text as TableText,
} from '@tallyui/components';
import type { StoreOrder } from '@tallyui/core';
import type { PosOrder, UseOrderOutboxResult } from '@tallyui/pos';
import { formatDayHeader } from '../lib/format-date';
import { orderStatusBadge } from '../lib/order-detail';
import { groupOrderRowsByDay, orderBillingCell, orderRowDate, ordersTableCells, storeOrderTableCells } from '../lib/orders-table';
import type { OrdersRow } from '../lib/store-orders';

const NO_BILLING: ReadonlyMap<string, string | null> = new Map();
const HEADS = ['Status', 'Order Number', 'Customer', 'Billing Address', 'Date Created', 'Cashier', 'Payment Method', 'Total'];
// v2's Billing Address column is twice as wide as the others; its cells below take the same `flex-[2]`.
const HEAD_CLASS: Partial<Record<string, string>> = { 'Billing Address': 'flex-[2]', Total: 'items-end' };
// ADR 0009: below this width the rows are two lines, as Products' phone list, in place of the 1160 px table; Billing Address,
// Cashier and Payment Method stay in the detail sheet a row opens.
const PHONE_BREAKPOINT = 600;

// v2's Orders table: a row opens the sale. With `onRetry` (the attention table only) each row is followed by a
// full-width row of TallyUI's OrderSyncNotices, which says why the sale needs attention and holds Retry, as OrdersList does.
// `rows` mixes the till's sales with orders only the store has; `orders` lists the till's sales alone. `billing` holds the
// store orders' addresses by id; `days` puts v2's day headers (Today, Yesterday, then the date) between the rows.
export function OrdersTable({ orders, rows, testID, rowTestID = `${testID}-row`, formatDate, onOpen, onOpenStore, onRetry, stuck,
  billing = NO_BILLING, days }: {
  orders?: PosOrder[]; rows?: OrdersRow[]; testID: string; rowTestID?: string; formatDate: (iso: string) => string;
  billing?: ReadonlyMap<string, string | null>; days?: boolean;
  onOpen: (id: string) => void; onOpenStore?: (order: StoreOrder) => void;
  onRetry?: (orderIds: string[]) => Promise<number>; stuck?: UseOrderOutboxResult['state']['stuck'];
}) {
  const items = useMemo<OrdersRow[]>(() => rows ?? (orders ?? []).map((order) => ({ kind: 'local', key: order.id, order })),
    [rows, orders]);
  // The ref stops a second press before React re-renders; the state disables the button.
  const retrying = useRef(new Set<string>());
  const [retryingIds, setRetryingIds] = useState(new Set<string>());
  const phone = useWindowDimensions().width < PHONE_BREAKPOINT;
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
  const groups = days ? groupOrderRowsByDay(items) : [{ day: null, rows: items }];
  const dayLabel = (group: (typeof groups)[number]) => formatDayHeader(orderRowDate(group.rows[0]!));
  const line = (item: OrdersRow) => ({
    row: `${rowTestID}-${item.key}`,
    cells: item.kind === 'local'
      ? { ...ordersTableCells(item.order), status: orderStatusBadge(item.order), number: orderReference(item.order),
        date: item.order.createdAt }
      : { ...storeOrderTableCells(item.order), retryable: false },
    notices: onRetry && item.kind === 'local' ? item.order : null,
    open: () => item.kind === 'local' ? onOpen(item.order.id) : onOpenStore?.(item.order),
  });
  const syncNotices = (order: PosOrder, row: string, retryable: boolean) => <OrderSyncNotices order={order} stuck={stuck}>
    {retryable ? <Button size="sm" testID={`${row}-retry`} accessibilityLabel="Retry" className="self-start"
      disabled={retryingIds.has(order.id)} onPress={() => { void retry(order.id); }}>
      <TableText>Retry</TableText>
    </Button> : null}
  </OrderSyncNotices>;
  // The phone's rows run edge to edge under the screen's padding, with a divider under each, as Products' phone list.
  if (phone) return <View testID={testID} className="-mx-4">{groups.map((group) => <Fragment key={group.day ?? ''}>
    {group.day ? <View testID={`${rowTestID}-day-${group.day}`} className="bg-muted/50 px-4 py-2">
      <Text accessibilityRole="header" className="text-xs font-medium uppercase text-muted-foreground">{dayLabel(group)}</Text>
    </View> : null}
    {group.rows.map((item) => {
      const { row, cells, notices, open } = line(item);
      return <Fragment key={item.key}>
        <View testID={row} className={notices ? undefined : 'border-b border-border'}>
          <Pressable accessibilityRole="button" accessibilityLabel={`Open order ${cells.number}`} onPress={open} className="gap-1 px-4 py-3">
            <View className="flex-row items-center gap-3">
              <Text testID={`${row}-number`} numberOfLines={1} className="min-w-0 flex-1 text-foreground">{cells.number}</Text>
              <Text testID={`${row}-total`} className="text-right tabular-nums text-foreground">{cells.total}</Text>
            </View>
            <View className="flex-row items-center gap-2">
              <View testID={`${row}-status`}><OrderStatusBadge status={cells.status} /></View>
              <Text numberOfLines={1} className="min-w-0 flex-1 text-sm text-muted-foreground">
                <Text testID={`${row}-customer`}>{cells.customer}</Text>{' · '}<Text testID={`${row}-date`}>{formatDate(cells.date)}</Text>
              </Text>
            </View>
          </Pressable>
        </View>
        {notices ? <View testID={`${row}-notices`} className="gap-1 border-b border-border px-4 pb-3">
          {syncNotices(notices, row, cells.retryable)}
        </View> : null}
      </Fragment>;
    })}
  </Fragment>)}</View>;
  return <ScrollView horizontal contentContainerClassName="grow">
    <Table testID={testID} className="min-w-[1160px] w-full">
      <TableHeader><TableRow>
        {HEADS.map((label) => <TableHead key={label} className={HEAD_CLASS[label]}>
          <TableText className={label === 'Total' ? 'text-right' : undefined}>{label}</TableText>
        </TableHead>)}
        <TableHead className="w-10 flex-none" />
      </TableRow></TableHeader>
      <TableBody>{groups.map((group) => <Fragment key={group.day ?? ''}>
        {group.day ? <TableRow testID={`${rowTestID}-day-${group.day}`} className="bg-muted/50">
          <TableCell className="py-2"><Text accessibilityRole="header" className="text-xs font-medium uppercase text-muted-foreground">
            {dayLabel(group)}</Text></TableCell>
        </TableRow> : null}
        {group.rows.map((item) => {
        const { row, cells, notices, open } = line(item);
        const muted = (value: string) => value === '—' ? 'text-muted-foreground' : 'text-foreground';
        const address = orderBillingCell(item, billing);
        return <Fragment key={item.key}>
          {/* The notices row below carries the line under an attention row. */}
          <TableRow testID={row} className={notices ? 'border-b-0' : undefined}>
            <Pressable accessibilityRole="button" accessibilityLabel={`Open order ${cells.number}`}
              onPress={open} className="flex-1 flex-row">
              <TableCell testID={`${row}-status`}><OrderStatusBadge status={cells.status} /></TableCell>
              <TableCell testID={`${row}-number`}><Text className="text-foreground">{cells.number}</Text></TableCell>
              <TableCell testID={`${row}-customer`}><Text className="text-foreground">{cells.customer}</Text></TableCell>
              <TableCell testID={`${row}-billing`} className="flex-[2]"><Text numberOfLines={2} className={muted(address)}>{address}</Text></TableCell>
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
              {syncNotices(notices, row, cells.retryable)}
            </TableCell>
          </TableRow> : null}
        </Fragment>;
        })}
      </Fragment>)}</TableBody>
    </Table>
  </ScrollView>;
}
