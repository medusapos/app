import { useEffect, useState } from 'react';
import { Platform, ScrollView, View } from 'react-native';
import {
  Button, Dialog, DialogClose, DialogContent, DialogTitle, IconButton, OrderDetail, orderReference, Receipt, Text, XIcon,
} from '@tallyui/components';
import { formatMoney } from '@tallyui/core';
import { buildReceiptDataFromPosOrder, type PosOrder } from '@tallyui/pos';
import { orderDetailFigures, orderStatusBadge, paymentLabel, receiptTaxLabel } from '../lib/order-detail';
import { defaultStorage } from '../lib/session';
import { useSession } from '../lib/session-context';
import { loadCachedSettings } from '../lib/store-settings';

// While a reprint shows, a print keeps only it: other branches collapse, its ancestors stop positioning, clipping and
// painting, and it moves to the page's top left. Inert without a reprint on the page, so the paid screen prints as before.
const RECEIPT = '[data-print="receipt"]';
const RECEIPT_PRINT_CSS = `@media print {
  body:has(${RECEIPT}) *:not(:has(${RECEIPT})):not(${RECEIPT}):not(${RECEIPT} *) { display: none !important }
  :has(${RECEIPT}) { visibility: hidden; position: static !important; overflow: visible !important; transform: none !important }
  ${RECEIPT} { visibility: visible; position: absolute !important; top: 0; left: 0; width: 100%; height: auto !important; overflow: visible !important }
}`;
function injectReceiptPrintStyle() {
  if (Platform.OS !== 'web' || typeof document === 'undefined' || document.getElementById('order-receipt-print-style')) return;
  const style = document.createElement('style');
  style.id = 'order-receipt-print-style';
  style.textContent = RECEIPT_PRINT_CSS;
  document.head.appendChild(style);
}

// One stored sale, read-only, in a right-hand sheet as WCPOS v2 opens an order.
export function OrderDetailSheet({ order, onClose, formatDate }: {
  order: PosOrder | null; onClose: () => void; formatDate: (iso: string) => string;
}) {
  const { session } = useSession();
  const [reprint, setReprint] = useState(false);
  // Each sale opens on its detail; keyed on the id, so a live sync-status update keeps the receipt up.
  useEffect(() => setReprint(false), [order?.id]);
  useEffect(() => { if (reprint) injectReceiptPrintStyle(); }, [reprint]);
  const money = (amount: number) => (order ? formatMoney({ amount, currency: order.currency }) : undefined) ?? '';
  const settings = session?.baseUrl ? loadCachedSettings(defaultStorage(), session.baseUrl) : null;
  return <Dialog open={order !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
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
          posOrder={order} taxLabel={receiptTaxLabel} formatDate={formatDate} doneLabel="Back" newSale={() => setReprint(false)} />
      </ScrollView> : <OrderDetail testID="order-detail" orderNumber={`Order ${orderReference(order)}`} status={orderStatusBadge(order)}
        {...orderDetailFigures(order)}
        customerSlot={<View className="gap-1">
          <Text className="text-sm text-muted-foreground">{formatDate(order.createdAt)}</Text>
          <Text className="text-sm text-foreground">{order.customer?.name || order.customer?.email || 'Guest'}</Text>
        </View>}
        paymentSlot={<View className="gap-1">
          <Text className="text-xs font-semibold text-muted-foreground">Payment</Text>
          {order.payments.map((payment) => <View key={payment.id} className="gap-1">
            <View className="flex-row justify-between">
              <Text className="text-sm text-foreground">{paymentLabel(payment.method)}</Text>
              <Text className="text-sm text-foreground">{money(payment.amountMinor)}</Text>
            </View>
            {(payment.changeMinor ?? 0) > 0 ? <View className="flex-row justify-between">
              <Text className="text-sm text-muted-foreground">Change</Text>
              <Text className="text-sm text-muted-foreground">{money(payment.changeMinor ?? 0)}</Text>
            </View> : null}
          </View>)}
        </View>}
        footerSlot={<View className="flex-row gap-2">
          <Button variant="outline" className="flex-1" testID="order-detail-close" onPress={onClose}><Text>Close</Text></Button>
          <Button variant="outline" className="flex-1" testID="order-detail-receipt" onPress={() => setReprint(true)}><Text>Receipt</Text></Button>
        </View>} />}
    </DialogContent> : null}
  </Dialog>;
}
