import { ScrollView, Text, View } from 'react-native';
import { Redirect, Stack } from 'expo-router';
import { formatMoney } from '@tallyui/core';
import { needsAttention } from '../lib/order-store';
import { useOutboxContext } from '../lib/outbox-context';
import { useSession } from '../lib/session-context';

export default function OrdersScreen() {
  const { session } = useSession();
  const { recent } = useOutboxContext();
  if (!session) return <Redirect href="/login" />;
  return <ScrollView className="flex-1 bg-background p-4">
    <Stack.Screen options={{ title: 'Orders' }} />
    {[{ title: 'Needs attention', orders: needsAttention(recent) }, { title: 'Recent', orders: recent }].filter((section) => section.title === 'Recent' || section.orders.length > 0).map((section) => (
      <View key={section.title} className="mb-6 gap-3">
        <Text accessibilityRole="header" className="text-xl font-semibold text-foreground">{section.title}</Text>
        {section.orders.map((order) => (
          <View key={order.id} className="gap-1 rounded-md border border-border bg-card p-3">
            <Text className="text-muted-foreground">{new Date(order.createdAt).toLocaleString()} · {formatMoney({ amount: order.totalMinor, currency: order.currency })}</Text>
            <Text className="text-muted-foreground">{order.syncStatus}{order.syncStatus === 'applied' && order.serverRefs?.displayId ? ` · ${order.serverRefs.displayId}` : ''}</Text>
            {order.syncStatus === 'rejected' && order.error ? <Text className="text-destructive">{order.error.code}: {order.error.message}</Text> : null}
            {order.warnings?.map((warning, index) => <View key={index} className="border-l-4 border-warning pl-2"><Text className="text-foreground">
              {warning.code === 'insufficient_stock'
                ? `Stock short by ${warning.quantity} for ${order.lines.find((line) => line.variantId === warning.variantId)?.name}`
                : `Store total ${formatMoney({ amount: warning.serverMinor, currency: order.currency })} vs POS ${formatMoney({ amount: warning.expectedMinor, currency: order.currency })}`}
            </Text></View>)}
          </View>
        ))}
      </View>
    ))}
  </ScrollView>;
}
