import { useState } from 'react';
import { View, Text, TextInput, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import {
  OrderSummary,
  PaymentSelector,
} from '@tallyui/components';
import type { PaymentMethod } from '@tallyui/components';
import { useCurrencyFormatter } from '@tallyui/pos';
import { useOrderBuilder, useOrder } from '../lib/hooks/use-order-builder';
import { useCompletedOrders } from '../lib/hooks/use-completed-orders';

const PAYMENT_METHODS: PaymentMethod[] = [
  { id: 'cash', label: 'Cash' },
  { id: 'card', label: 'Card' },
];

export default function CheckoutScreen() {
  const router = useRouter();
  const builder = useOrderBuilder();
  const order = useOrder();
  const formatMoney = useCurrencyFormatter();
  const { saveCompletedOrder } = useCompletedOrders();

  const [selectedMethod, setSelectedMethod] = useState('cash');
  const [cashTendered, setCashTendered] = useState('');

  const tenderedAmount = parseFloat(cashTendered) || 0;
  const changeDue = selectedMethod === 'cash'
    ? Math.max(0, tenderedAmount - order.total)
    : 0;
  const canComplete = selectedMethod === 'card' || tenderedAmount >= order.total;

  function handleComplete() {
    const amount = selectedMethod === 'cash' ? tenderedAmount : order.total;
    builder.addPayment({ method: selectedMethod, amount });
    const finalOrder = builder.getSnapshot();
    saveCompletedOrder(finalOrder);
    builder.clear();
    router.replace('/');
  }

  // Guard: if cart is empty, go back
  if (order.lineItems.length === 0) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <Text style={{ color: '#6b7280', marginBottom: 16 }}>No items in cart</Text>
        <Pressable onPress={() => router.back()}>
          <Text style={{ color: '#6366f1', fontWeight: '600' }}>Back to POS</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#f8f9fa' }}>
      {/* Header */}
      <View style={{ flexDirection: 'row', alignItems: 'center', padding: 16, borderBottomWidth: 1, borderBottomColor: '#e5e7eb', backgroundColor: '#fff' }}>
        <Pressable onPress={() => router.back()}>
          <Text style={{ color: '#6366f1', fontWeight: '600', fontSize: 16 }}>← Back</Text>
        </Pressable>
        <Text style={{ flex: 1, textAlign: 'center', fontSize: 18, fontWeight: 'bold' }}>Checkout</Text>
        <View style={{ width: 50 }} />
      </View>

      <View style={{ flex: 1, maxWidth: 500, alignSelf: 'center', width: '100%', padding: 24 }}>
        {/* Order Summary */}
        <OrderSummary
          subtotal={formatMoney(order.subtotal)}
          tax={formatMoney(order.taxTotal)}
          taxLabel="Tax (10%)"
          total={formatMoney(order.total)}
        />

        {/* Payment Method */}
        <View style={{ marginTop: 24 }}>
          <Text style={{ fontSize: 16, fontWeight: '600', marginBottom: 12 }}>Payment Method</Text>
          <PaymentSelector
            methods={PAYMENT_METHODS}
            selected={selectedMethod}
            onSelect={setSelectedMethod}
          />
        </View>

        {/* Cash Input */}
        {selectedMethod === 'cash' && (
          <View style={{ marginTop: 24 }}>
            <Text style={{ fontSize: 14, color: '#6b7280', marginBottom: 8 }}>Cash Tendered</Text>
            <TextInput
              value={cashTendered}
              onChangeText={setCashTendered}
              keyboardType="decimal-pad"
              placeholder="0.00"
              style={{
                borderWidth: 1,
                borderColor: '#e5e7eb',
                borderRadius: 8,
                padding: 14,
                fontSize: 24,
                textAlign: 'center',
                backgroundColor: '#fff',
              }}
            />
            {tenderedAmount > 0 && (
              <View style={{ marginTop: 16, alignItems: 'center' }}>
                <Text style={{ color: '#6b7280', fontSize: 14 }}>Change Due</Text>
                <Text style={{ fontSize: 28, fontWeight: 'bold', color: '#059669', marginTop: 4 }}>
                  {formatMoney(changeDue)}
                </Text>
              </View>
            )}
          </View>
        )}

        {/* Complete Button */}
        <Pressable
          onPress={handleComplete}
          disabled={!canComplete}
          style={{
            marginTop: 32,
            backgroundColor: canComplete ? '#059669' : '#d1d5db',
            paddingVertical: 16,
            borderRadius: 8,
            alignItems: 'center',
          }}
        >
          <Text style={{ color: '#fff', fontWeight: 'bold', fontSize: 18 }}>
            {selectedMethod === 'card'
              ? `Charge ${formatMoney(order.total)}`
              : 'Complete Sale'}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
