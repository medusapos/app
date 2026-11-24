import { View } from 'react-native';
import { Button, Dialog, DialogClose, DialogContent, DialogTitle, IconButton, OrderDetail, Text, XIcon } from '@tallyui/components';
import { formatMoney, type StoreOrder } from '@tallyui/core';
import { storeOrderDetailFigures, storeOrderStatus } from '../lib/store-orders';

// An order only the store has, read-only, in the same right-hand sheet as the till's own sales. It has no Receipt,
// Sync or Refund: the till didn't ring it up, so there is nothing of its own to print, send or refund.
export function StoreOrderDetailSheet({ order, onClose, formatDate }: {
  order: StoreOrder | null; onClose: () => void; formatDate: (iso: string) => string;
}) {
  const money = (amount: number) => (order ? formatMoney({ amount, currency: order.currency }) : undefined) ?? '';
  return <Dialog open={order !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
    {order ? <DialogContent side="right" testID="store-order-detail-sheet" className="flex-col p-0">
      <View className="flex-row items-center justify-end px-4 pt-4">
        <DialogTitle className="sr-only">{`Order #${order.reference}`}</DialogTitle>
        <DialogClose asChild>
          <IconButton variant="ghost" size="sm" testID="store-order-dismiss" accessibilityLabel="Close panel">
            <XIcon size={16} />
          </IconButton>
        </DialogClose>
      </View>
      <OrderDetail testID="store-order-detail" orderNumber={`Order #${order.reference}`} status={storeOrderStatus(order.status)}
        {...storeOrderDetailFigures(order)}
        customerSlot={<View className="gap-1">
          <Text className="text-sm text-muted-foreground">{formatDate(order.placedAt)}</Text>
          <Text className="text-sm text-foreground">{order.customer?.name || order.customer?.email || 'Guest'}</Text>
        </View>}
        paymentSlot={<View className="gap-1">
          <Text className="text-xs font-semibold text-muted-foreground">Payment</Text>
          {order.payments.map((payment, index) => <View key={payment.id ?? index} className="flex-row justify-between">
            <Text className="text-sm text-foreground">{payment.method}</Text>
            <Text className="text-sm text-foreground">{money(payment.amountMinor)}</Text>
          </View>)}
        </View>}
        footerSlot={<View className="flex-row gap-2">
          <Button variant="outline" className="flex-1" testID="store-order-close" onPress={onClose}><Text>Close</Text></Button>
        </View>} />
    </DialogContent> : null}
  </Dialog>;
}
