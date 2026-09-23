import { Pressable, Text, TextInput, View } from 'react-native';
import { CashTendered, ChangeDisplay } from '@tallyui/components';
import { formatMoney } from '@tallyui/core';
import type { useSale } from '../lib/use-sale';

export function Tender({ sale }: { sale: ReturnType<typeof useSale> }) {
  const { order, stage } = sale;
  if (stage.kind !== 'tender') return null;
  const money = (amount: number) => ({ amount, currency: order.currency });
  return <View dataSet={{ print: 'hide' }} className="gap-4 p-4">
    {stage.method === 'cash' ? <>
      <CashTendered total={money(order.totalMinor)} amount={money(order.payments[0]?.amountMinor ?? 0)}
        onChangeAmount={(amount) => sale.setTender({ method: 'cash', amountMinor: amount.amount })} />
      <ChangeDisplay change={money(order.changeDueMinor)} />
      {order.balanceDueMinor > 0 ? <Text>Balance due: {formatMoney(money(order.balanceDueMinor))}</Text> : null}
      <Pressable accessibilityRole="button" disabled={order.balanceDueMinor > 0} onPress={sale.complete}>
        <Text>Complete sale</Text>
      </Pressable>
    </> : <>
      <Text>Card terminal: {formatMoney(money(order.totalMinor))}</Text>
      <TextInput accessibilityLabel="Terminal reference" placeholder="Terminal reference"
        value={order.payments[0]?.reference ?? ''}
        onChangeText={(reference) => sale.setTender({ method: 'external', amountMinor: order.totalMinor, reference })} />
      <Pressable accessibilityRole="button" onPress={sale.complete}><Text>Payment approved on terminal</Text></Pressable>
    </>}
    {sale.error ? <Text accessibilityRole="alert">{sale.error}</Text> : null}
    <Pressable accessibilityRole="button" onPress={sale.cancelTender}><Text>Back</Text></Pressable>
  </View>;
}
