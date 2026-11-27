import { useEffect, useState } from 'react';
import { Platform, ScrollView, View } from 'react-native';
import {
  Button, Dialog, DialogClose, DialogContent, DialogTitle, IconButton, OrderDetail, orderReference, OrderSyncNotices, Receipt, Text, XIcon,
} from '@tallyui/components';
import { formatMoney, type StoreOrder, type StoreOrderRefund } from '@tallyui/core';
import { buildReceiptDataFromPosOrder, mintUuid, refundDueOf, type PosOrder, type PosRefund, type PosRefundCollection, type UseOrderOutboxResult } from '@tallyui/pos';
import {
  canSyncOrder, orderDetailFigures, orderStatusBadge, paymentLabel, receiptTaxLabel, syncOrder,
} from '../lib/order-detail';
import { formatReceiptDate } from '../lib/format-date';
import { ordersTableCells } from '../lib/orders-table';
import { useOutboxOrders } from '../lib/outbox-context';
import { PARTIAL_REFUND_PLUGIN_CONTRACT } from '../lib/plugin-contract';
import { usePrinterProfiles } from '../lib/printers';
import { printSalePage, RECEIPT_TEMPLATES, receiptTemplatePage, useReceiptPrinter, useReceiptTemplate } from '../lib/receipt-templates';
import { refundFormInput } from '../lib/refund';
import { defaultStorage } from '../lib/session';
import { useSession } from '../lib/session-context';
import { loadCachedSettings } from '../lib/store-settings';
import { printReceiptToNetwork } from '../lib/thermal-printing';
import { OrderRefundDialog, useRefundRecords } from './order-refund-dialog';
import { OrderRefundModal } from './order-refund-modal';
import { PaidFooter } from './paid-footer';
import { chosenNetworkPrinter, ReceiptPickers, ThermalPaidReceipt } from './receipt-pickers';

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

const refundAmount = (record: PosRefund) => record.result?.totalMinor ?? record.envelope.payload.totalMinor;
// A refund's lines as a multiset of orderLineId × quantity, in a fixed order; restock and net/tax play no part.
const lineKey = (lines: readonly { orderLineId: string; quantity: number }[]) =>
  JSON.stringify(lines.filter((line) => line.quantity > 0).map((line) => [line.orderLineId, line.quantity]).sort());

/**
 * This till's applied refunds the store's copy does not carry yet. The applied result ids are the plugin's own
 * (`<tally refund id>:<n>`), never the store's refund ids, so a refund is matched by what it refunded: equal line
 * multisets, or, for a refund without lines, a store refund without lines of the same amount. Each store refund
 * matches one record at most, in the records' creation order. A zero refund (stock only) creates no store refund.
 */
export function unlandedRefunds(records: readonly PosRefund[], storeRefunds: readonly StoreOrderRefund[]): PosRefund[] {
  const free = storeRefunds.map((refund) => ({ key: lineKey(refund.lines ?? []), amountMinor: refund.amountMinor }));
  return [...records].filter((record) => record.status === 'applied')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .filter((record) => {
      if (refundAmount(record) === 0) return false;
      const key = lineKey(record.envelope.payload.lines);
      const match = free.findIndex((refund) => refund.key === key && (key !== '[]' || refund.amountMinor === refundAmount(record)));
      if (match < 0) return true;
      free.splice(match, 1);
      return false;
    });
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
  /** The store's copy of this sale and this till's `pos_refunds`: Refund (ADR 0026, #569) needs both. */
  storeOrder?: StoreOrder | null; refunds?: PosRefundCollection;
  /** The Billing Address the sale's table row shows ('—' when it has none). */
  billing?: string;
}) {
  const { session } = useSession();
  const [reprint, setReprint] = useState(false);
  const [syncing, setSyncing] = useState(false);
  // What is open over the sheet: the refund form, or the dialog that resends a refund sent without a final answer.
  const [refunding, setRefunding] = useState<null | string | PosRefund>(null);
  // Why the form handed its refund to the resume dialog.
  const [handoff, setHandoff] = useState('');
  // Each sale opens on its detail; keyed on the id, so a live sync-status update keeps the receipt up.
  useEffect(() => { setReprint(false); setRefunding(null); setHandoff(''); }, [order?.id]);
  const records = useRefundRecords(refunds, storeOrder?.id ?? undefined);
  const resume = records?.find((record) => record.status === 'pending' || record.status === 'unsent') ?? null;
  const capabilities = session?.capabilities;
  const gate = !!order && !!storeOrder && records !== null && (capabilities?.orderRefund ?? 0) >= 1
    && (capabilities?.pluginContract ?? 0) >= PARTIAL_REFUND_PLUGIN_CONTRACT;
  const input = gate && order && storeOrder ? refundFormInput(storeOrder, order.payments) : null;
  // Until the store's copy carries each applied refund, the form would read stale remaining quantities: no new refund starts.
  const unlanded = unlandedRefunds(records ?? [], storeOrder?.refunds ?? []);
  const canRefund = gate && !resume && unlanded.length === 0 && !!input?.offered;
  const canResume = gate && !!resume;
  // A refund sent without a final answer opens again on its own envelope when its sale does; never over the open form,
  // whose own send is pending until it answers.
  useEffect(() => { if (canResume && resume) setRefunding((open) => open ?? resume); }, [order?.id, resume?.id, canResume]);
  const refundedParts = [...(storeOrder?.refunds.map((refund) => refund.amountMinor) ?? []),
    ...unlanded.map(refundAmount)];
  const refundedMinor = refundedParts.length ? refundedParts.reduce((total, amount) => total + amount, 0) : null;
  useEffect(() => { if (reprint) injectReceiptPrintStyle(); }, [reprint]);
  const money = (amount: number) => (order ? formatMoney({ amount, currency: order.currency }) : undefined) ?? '';
  const settings = session?.baseUrl ? loadCachedSettings(defaultStorage(), session.baseUrl) : null;
  const { templateId, save } = useReceiptTemplate(defaultStorage(), session?.baseUrl ?? '');
  const printers = usePrinterProfiles(useOutboxOrders());
  const { printerId, save: savePrinter } = useReceiptPrinter(defaultStorage(), session?.baseUrl ?? '', templateId);
  const pickers = Platform.OS === 'web';
  const paper = pickers ? RECEIPT_TEMPLATES.find((template) => template.id === templateId)?.paper : undefined;
  // A PosOrder keeps no cashier, so the reprint prints no Cashier line.
  const receipt = reprint && order ? buildReceiptDataFromPosOrder(order, {
    storeName: settings?.storeName ?? '', storeAddress: settings?.location.addressLine,
  }) : null;
  const reprintReceipt = receipt && order ? { ...receipt, header: { ...receipt.header, orderNumber: orderReference(order) } } : null;
  const page = paper && reprintReceipt ? receiptTemplatePage(paper, reprintReceipt) : null;
  const networkPrinter = paper ? chosenNetworkPrinter(templateId, printers, printerId) : undefined;
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
      {receipt ? <ScrollView testID="order-detail-receipt-view" dataSet={{ print: 'receipt' }} className="flex-1">
        {pickers && <ReceiptPickers templateId={templateId} onTemplateChange={save} printers={printers} printerId={printerId} onPrinterChange={savePrinter} />}
        {page ? <><ThermalPaidReceipt page={page} />
          <PaidFooter key={`${templateId}:${networkPrinter?.id ?? 'system'}`}
            print={paper && networkPrinter && reprintReceipt ? () => printReceiptToNetwork(networkPrinter, reprintReceipt, paper) : () => printSalePage(page)}
            doneLabel="Back" newSale={() => setReprint(false)} />
        </> : <Receipt receipt={receipt} posOrder={order} taxLabel={receiptTaxLabel} formatDate={formatReceiptDate}
          doneLabel="Back" newSale={() => setReprint(false)} />}
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
        onRefund={canRefund ? () => setRefunding(mintUuid()) : undefined}
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
    {typeof refunding === 'string' && order && storeOrder && refunds && input?.offered ? <OrderRefundModal order={storeOrder} clientRefundId={refunding}
      tenders={order.payments} refunds={refunds} input={input} onClose={() => setRefunding(null)}
      onUnanswered={(message, record) => { setHandoff(message); setRefunding(record); }} /> : null}
    {refunding && typeof refunding === 'object' && order && storeOrder && refunds && records !== null ? <OrderRefundDialog key={refunding.id} order={storeOrder}
      tenders={order.payments} refunds={refunds} resume={refunding} notice={handoff || undefined}
      onClose={() => { setRefunding(null); setHandoff(''); }} /> : null}
  </>;
}
