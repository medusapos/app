import { Pressable, Text, TextInput, View } from 'react-native';
import { CashTendered, ChangeDisplay } from '@tallyui/components';
import { formatMoney } from '@tallyui/core';
import type { useSale } from '@tallyui/pos';

export function Tender({ sale }: { sale: ReturnType<typeof useSale> }) {
  const { order, stage } = sale;
  if (stage.kind !== 'tender') return null;
  const money = (amount: number) => ({ amount, currency: order.currency });
  return <View dataSet={{ print: 'hide' }} className="gap-4 p-4">
    {stage.method === 'cash' ? <>
      <CashTendered total={money(order.totalMinor)} amount={money(order.payments[0]?.amountMinor ?? 0)}
        onChangeAmount={(amount) => sale.setTender({ method: 'cash', amountMinor: amount.amount })} />
      <ChangeDisplay change={money(order.changeDueMinor)} />
      {order.balanceDueMinor > 0 ? <Text className="text-foreground">Balance due: {formatMoney(money(order.balanceDueMinor))}</Text> : null}
      <Pressable accessibilityRole="button" disabled={order.balanceDueMinor > 0} onPress={sale.complete} className={`rounded-md bg-primary px-4 py-3 ${order.balanceDueMinor > 0 ? 'opacity-50' : ''}`}>
        <Text className="text-center font-semibold text-primary-foreground">Complete sale</Text>
      </Pressable>
    </> : <>
      <Text className="text-foreground">Card terminal: {formatMoney(money(order.totalMinor))}</Text>
      <TextInput accessibilityLabel="Terminal reference" placeholder="Terminal reference"
        value={order.payments[0]?.reference ?? ''}
        onChangeText={(reference) => sale.setTender({ method: 'external', amountMinor: order.totalMinor, reference })} className="rounded-md border border-border px-3 py-2 text-foreground" />
      <Pressable accessibilityRole="button" onPress={sale.complete} className="rounded-md bg-primary px-4 py-3"><Text className="text-center font-semibold text-primary-foreground">Payment approved on terminal</Text></Pressable>
    </>}
    {sale.error ? <Text accessibilityRole="alert" className="text-destructive">{sale.error}</Text> : null}
    <Pressable accessibilityRole="button" onPress={sale.cancelTender} className="rounded-md border border-border bg-card px-4 py-3"><Text className="text-center text-foreground">Back</Text></Pressable>
  </View>;
}
