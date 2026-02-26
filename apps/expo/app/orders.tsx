import { View, Text, ScrollView, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { useCurrencyFormatter } from '@tallyui/pos';
import { useCompletedOrders } from '../lib/hooks/use-completed-orders';

export default function OrdersScreen() {
  const router = useRouter();
  const { orders } = useCompletedOrders();
  const formatMoney = useCurrencyFormatter();

  return (
    <View style={{ flex: 1, backgroundColor: '#f8f9fa' }}>
      {/* Header */}
      <View style={{
        flexDirection: 'row',
        alignItems: 'center',
        padding: 16,
        borderBottomWidth: 1,
        borderBottomColor: '#e5e7eb',
        backgroundColor: '#fff',
      }}>
        <Pressable onPress={() => router.back()}>
          <Text style={{ color: '#6366f1', fontWeight: '600', fontSize: 16 }}>← Back</Text>
        </Pressable>
        <Text style={{ flex: 1, textAlign: 'center', fontSize: 18, fontWeight: 'bold' }}>
          Orders
        </Text>
        <View style={{ width: 50 }} />
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, maxWidth: 600, alignSelf: 'center', width: '100%' }}>
        {orders.length === 0 ? (
          <View style={{ padding: 40, alignItems: 'center' }}>
            <Text style={{ color: '#6b7280', fontSize: 16 }}>No completed orders yet</Text>
            <Text style={{ color: '#9ca3af', marginTop: 8 }}>Complete a sale to see it here</Text>
          </View>
        ) : (
          orders.map((order) => (
            <View
              key={order.id}
              style={{
                backgroundColor: '#fff',
                borderRadius: 8,
                padding: 16,
                marginBottom: 12,
                borderWidth: 1,
                borderColor: '#e5e7eb',
              }}
            >
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={{ fontWeight: '600' }}>
                  Order #{order.id.slice(-6).toUpperCase()}
                </Text>
                <Text style={{ fontWeight: 'bold', color: '#059669' }}>
                  {formatMoney(order.total)}
                </Text>
              </View>
              <Text style={{ color: '#6b7280', fontSize: 13, marginTop: 6 }}>
                {order.lineItems.length} item{order.lineItems.length !== 1 ? 's' : ''} · {new Date(order.createdAt).toLocaleString()}
              </Text>
              <Text style={{ color: '#6b7280', fontSize: 13, marginTop: 2 }}>
                Paid: {order.payments.map((p) => p.method).join(', ')}
              </Text>
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}
