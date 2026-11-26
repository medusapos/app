import { useEffect, useState } from 'react';
import { Platform, ScrollView, View } from 'react-native';
import {
  Button, Dialog, DialogClose, DialogContent, DialogTitle, IconButton, OrderDetail, orderReference, OrderSyncNotices, Receipt, Text, XIcon,
} from '@tallyui/components';
import { formatMoney, type StoreOrder } from '@tallyui/core';
import { buildReceiptDataFromPosOrder, refundDueOf, type PosOrder, type PosRefundCollection, type UseOrderOutboxResult } from '@tallyui/pos';
import {
  canSyncOrder, orderDetailFigures, orderStatusBadge, paymentLabel, receiptTaxLabel, syncOrder,
} from '../lib/order-detail';
import { formatReceiptDate } from '../lib/format-date';
import { ordersTableCells } from '../lib/orders-table';
import { REFUND_PLUGIN_CONTRACT } from '../lib/plugin-contract';
import { fullRefundOffer } from '../lib/refund';
import { defaultStorage } from '../lib/session';
import { useSession } from '../lib/session-context';
import { loadCachedSettings } from '../lib/store-settings';
import { OrderRefundDialog, useRefundRecords } from './order-refund-dialog';

// While a reprint shows, a print keeps only it: other branches collapse, its ancestors stop positioning, clipping and
// painting, and it moves to the page's top left. Inert without a reprint on the page, so the paid screen prints as before.
const RECEIPT = '[data-print="receipt"]';
const RECEIPT_PRINT_CSS = `@media print {
  body:has(${RECEIPT}) *:not(:has(${RECEIPT})):not(${RECEIPT}):not(${RECEIPT} *) { display: none !important }
  :has(${RECEIPT}) { visibility: hidden; position: static !important; overflow: visible !important; transform: none !important }
  ${RECEIPT} { visibility: visible; position: absolute !important; top: 0; left: 0; width: 100%; height: auto !important; overflow: visible !important }
}`;
export function injectReceiptPrintStyle() {
  if (Platform.OS !== 'web' || typeof document === 'undefined' || document.getElementById('order-receipt-print-style')) return;
  const style = document.createElement('style');
  style.id = 'order-receipt-print-style';
  style.textContent = RECEIPT_PRINT_CSS;
  document.head.appendChild(style);
}

// One stored sale, read-only, in a right-hand sheet as WCPOS v2 opens an order.
// A labelled muted line in a sheet's customer block; nothing for an empty value or the table's '—'.
export function DetailLine({ testID, label, value }: { testID: string; label: string; value?: string }) {
  if (!value || value === '—') return null;
  return <View testID={testID}>
    <Text className="text-xs font-semibold text-muted-foreground">{label}</Text>
    <Text className="text-sm text-muted-foreground">{value}</Text>
  </View>;
}

export function OrderDetailSheet({ order, onClose, formatDate, onRetry, onFlush, stuck, storeOrder, refunds, billing }: {
  order: PosOrder | null; onClose: () => void; formatDate: (iso: string) => string;
  onRetry: (orderIds: string[]) => Promise<number>; onFlush: () => Promise<void>;
  stuck?: UseOrderOutboxResult['state']['stuck'];
  /** The store's copy of this sale and this till's `pos_refunds`: Refund all (ADR 0026) needs both. */
  storeOrder?: StoreOrder | null; refunds?: PosRefundCollection;
  /** The Billing Address the sale's table row shows ('—' when it has none). */
  billing?: string;
}) {
  const { session } = useSession();
  const [reprint, setReprint] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [refunding, setRefunding] = useState(false);
  // Each sale opens on its detail; keyed on the id, so a live sync-status update keeps the receipt up.
  useEffect(() => { setReprint(false); setRefunding(false); }, [order?.id]);
  const records = useRefundRecords(refunds, storeOrder?.id ?? undefined);
  const applied = records.find((record) => record.status === 'applied');
  const resume = records.find((record) => record.status === 'pending' || record.status === 'unsent') ?? null;
  const capabilities = session?.capabilities;
  const canRefund = !!order && !!storeOrder && !!refunds && (capabilities?.orderRefund ?? 0) >= 1
    && (capabilities?.pluginContract ?? 0) >= REFUND_PLUGIN_CONTRACT && !applied && fullRefundOffer(storeOrder, order.payments, true).offered;
  // A refund sent without a final answer opens again on its own envelope when its sale does.
  useEffect(() => { if (resume && canRefund) setRefunding(true); }, [order?.id, resume?.id, canRefund]);
  const refundedMinor = applied ? applied.result?.totalMinor ?? applied.envelope.payload.totalMinor
    : storeOrder?.refunds.length ? storeOrder.refunds.reduce((total, refund) => total + refund.amountMinor, 0) : null;
  useEffect(() => { if (reprint) injectReceiptPrintStyle(); }, [reprint]);
  const money = (amount: number) => (order ? formatMoney({ amount, currency: order.currency }) : undefined) ?? '';
  const settings = session?.baseUrl ? loadCachedSettings(defaultStorage(), session.baseUrl) : null;
  return <><Dialog open={order !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
    {order ? <DialogContent side="right" testID="order-detail-sheet" className="flex-col p-0">
      <View className="flex-row items-center justify-end px-4 pt-4">
        <DialogTitle className="sr-only">{`Order ${orderReference(order)}`}</DialogTitle>
        <DialogClose asChild>
          <IconButton variant="ghost" size="sm" testID="order-detail-dismiss" accessibilityLabel="Close panel">
            <XIcon size={16} />
          </IconButton>
        </DialogClose>
      </View>
      {reprint ? <ScrollView testID="order-detail-receipt-view" dataSet={{ print: 'receipt' }} className="flex-1">
        {/* A PosOrder keeps no cashier, so the reprint prints no Cashier line. */}
        <Receipt receipt={buildReceiptDataFromPosOrder(order, { storeName: settings?.storeName ?? '', storeAddress: settings?.location.addressLine })}
          posOrder={order} taxLabel={receiptTaxLabel} formatDate={formatReceiptDate} doneLabel="Back" newSale={() => setReprint(false)} />
      </ScrollView> : <OrderDetail testID="order-detail" orderNumber={`Order ${orderReference(order)}`} status={orderStatusBadge(order)}
        {...orderDetailFigures(order)}
        customerSlot={<View className="gap-1">
          <Text className="text-sm text-muted-foreground">{formatDate(order.createdAt)}</Text>
          <Text className="text-sm text-foreground">{order.customer?.name || order.customer?.email || 'Guest'}</Text>
          <DetailLine testID="order-detail-billing" label="Billing address" value={billing} />
          <DetailLine testID="order-detail-cashier" label="Cashier" value={ordersTableCells(order).cashier} />
          {order.note ? <Text testID="order-detail-note" className="text-sm text-muted-foreground">{`Customer note: ${order.note}`}</Text> : null}
          {/* The notices OrdersList showed under each sale. */}
          <View testID="order-detail-notices" className="gap-1"><OrderSyncNotices order={order} stuck={stuck} /></View>
        </View>}
        paymentSlot={<View className="gap-1">
          <Text className="text-xs font-semibold text-muted-foreground">Payment</Text>
          {order.payments.map((payment) => <View key={payment.id} className="gap-1">
            <View className="flex-row justify-between">
              <Text className="text-sm text-foreground">{paymentLabel(payment.method)}</Text>
              <Text className="text-sm text-foreground">{money(payment.amountMinor)}</Text>
            </View>
            {payment.reference ? <Text testID={`order-detail-payment-reference-${payment.id}`} className="text-sm text-muted-foreground">
              {payment.reference}</Text> : null}
            {(payment.changeMinor ?? 0) > 0 ? <View className="flex-row justify-between">
              <Text className="text-sm text-muted-foreground">Change</Text>
              <Text className="text-sm text-muted-foreground">{money(payment.changeMinor ?? 0)}</Text>
            </View> : null}
          </View>)}
          {refundDueOf(order) > 0 ? <View testID="order-detail-refund-due" className="flex-row justify-between">
            <Text className="text-sm text-foreground">Refund due</Text>
            <Text className="text-sm text-foreground">{money(refundDueOf(order))}</Text>
          </View> : null}
          {refundedMinor !== null ? <Text testID="order-detail-refunded" className="text-sm text-foreground">{`Refunded ${money(refundedMinor)}`}</Text> : null}
        </View>}
        onRefund={canRefund ? () => setRefunding(true) : undefined}
        footerSlot={<View className="flex-row gap-2">
          {canSyncOrder(order) ? <Button variant="outline" className="flex-1" testID="order-detail-sync" disabled={syncing}
            onPress={() => {
              setSyncing(true);
              // A failed send shows in the outbox's own state, so the sheet ignores the rejection.
              syncOrder({ flush: onFlush, requeue: onRetry }, order).catch(() => {}).finally(() => setSyncing(false));
            }}><Text>Sync</Text></Button> : null}
          <Button variant="outline" className="flex-1" testID="order-detail-close" onPress={onClose}><Text>Close</Text></Button>
          <Button variant="outline" className="flex-1" testID="order-detail-receipt" onPress={() => setReprint(true)}><Text>Receipt</Text></Button>
        </View>} />}
    </DialogContent> : null}
  </Dialog>
    {/* Over the sheet as user-sheet's SwitchConfirm: a sibling, since a dialog inside DialogContent never shows on web. */}
    {refunding && order && storeOrder && refunds ? <OrderRefundDialog order={storeOrder} tenders={order.payments} refunds={refunds} resume={resume}
      onClose={() => setRefunding(false)} /> : null}
  </>;
}
