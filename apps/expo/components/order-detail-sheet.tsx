import { View } from 'react-native';
import {
  Button, Dialog, DialogClose, DialogContent, DialogTitle, IconButton, OrderDetail, orderReference, Text, XIcon,
} from '@tallyui/components';
import { formatMoney } from '@tallyui/core';
import type { PosOrder } from '@tallyui/pos';
import { orderDetailFigures, orderStatusBadge, paymentLabel } from '../lib/order-detail';

// One stored sale, read-only, in a right-hand sheet as WCPOS v2 opens an order.
export function OrderDetailSheet({ order, onClose, formatDate }: {
  order: PosOrder | null; onClose: () => void; formatDate: (iso: string) => string;
}) {
  const money = (amount: number) => (order ? formatMoney({ amount, currency: order.currency }) : undefined) ?? '';
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
      <OrderDetail testID="order-detail" orderNumber={`Order ${orderReference(order)}`} status={orderStatusBadge(order)}
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
        footerSlot={<Button variant="outline" testID="order-detail-close" onPress={onClose}><Text>Close</Text></Button>} />
    </DialogContent> : null}
  </Dialog>;
}
