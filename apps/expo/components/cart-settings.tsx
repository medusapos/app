import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Circle, Line } from 'react-native-svg';
import { Button, createSvgIcon, Dialog, DialogContent, DialogTitle, IconButton, Input, Label, Text } from '@tallyui/components';
import { DEFAULT_CART_SETTINGS, type useCartSettings } from '../lib/cart-settings';

const SlidersIcon = createSvgIcon('SlidersIcon', () => <>
  <Line x1={3} y1={6} x2={21} y2={6} /><Circle cx={8} cy={6} r={2} />
  <Line x1={3} y1={12} x2={21} y2={12} /><Circle cx={16} cy={12} r={2} />
  <Line x1={3} y1={18} x2={21} y2={18} /><Circle cx={8} cy={18} r={2} />
</>);

export function CartSettingsButton({ settings, save, reset }: ReturnType<typeof useCartSettings>) {
  const [open, setOpen] = useState(false);
  const [a, setA] = useState(String(settings.quickDiscounts[0]));
  const [b, setB] = useState(String(settings.quickDiscounts[1]));
  const [c, setC] = useState(String(settings.quickDiscounts[2]));
  const [error, setError] = useState<string | null>(null);
  function onSave() {
    try { save({ ...settings, quickDiscounts: [Number(a), Number(b), Number(c)] }); setError(null); }
    catch (err) { setError((err as Error).message); }
  }
  function onReset() {
    reset(); setA(String(DEFAULT_CART_SETTINGS.quickDiscounts[0]));
    setB(String(DEFAULT_CART_SETTINGS.quickDiscounts[1])); setC(String(DEFAULT_CART_SETTINGS.quickDiscounts[2])); setError(null);
  }
  return <>
    <IconButton testID="cart-settings-button" accessibilityLabel="Cart settings" onPress={() => setOpen(true)}><SlidersIcon /></IconButton>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent side="right" testID="cart-settings-sheet" className="flex-col gap-4">
        <DialogTitle>Cart Settings</DialogTitle>
        <Text>Panel position</Text>
        <View className="flex-row gap-2">
          {(['left', 'right'] as const).map((side) => {
            const selected = settings.cartSide === side;
            return <Pressable key={side} testID={`cart-settings-side-${side}`} accessibilityRole="button"
              accessibilityState={{ selected }} aria-selected={selected} onPress={() => save({ ...settings, cartSide: side })}
              className={`min-h-11 flex-1 items-center justify-center rounded-lg border-2 px-2 py-2 ${selected ? 'border-primary bg-muted' : 'border-border bg-card'}`}>
              <Text>{side === 'left' ? 'Cart left' : 'Cart right'}</Text>
            </Pressable>;
          })}
        </View>
        <Text>Open orders position</Text>
        <View className="flex-row gap-2">
          {(['top', 'bottom'] as const).map((position) => {
            const selected = settings.openOrders === position;
            return <Pressable key={position} testID={`cart-settings-open-orders-${position}`} accessibilityRole="button"
              accessibilityState={{ selected }} aria-selected={selected} onPress={() => save({ ...settings, openOrders: position })}
              className={`min-h-11 flex-1 items-center justify-center rounded-lg border-2 px-2 py-2 ${selected ? 'border-primary bg-muted' : 'border-border bg-card'}`}>
              <Text>{position === 'top' ? 'Top' : 'Bottom'}</Text>
            </Pressable>;
          })}
        </View>
        <Text>Quick Discounts</Text>
        <Label nativeID="cart-settings-discount-1-label">Quick discount 1</Label>
        <Input><Input.Field accessibilityLabel="Quick discount 1" aria-labelledby="cart-settings-discount-1-label"
          keyboardType="number-pad" value={a} onChangeText={setA} /></Input>
        <Label nativeID="cart-settings-discount-2-label">Quick discount 2</Label>
        <Input><Input.Field accessibilityLabel="Quick discount 2" aria-labelledby="cart-settings-discount-2-label"
          keyboardType="number-pad" value={b} onChangeText={setB} /></Input>
        <Label nativeID="cart-settings-discount-3-label">Quick discount 3</Label>
        <Input><Input.Field accessibilityLabel="Quick discount 3" aria-labelledby="cart-settings-discount-3-label"
          keyboardType="number-pad" value={c} onChangeText={setC} /></Input>
        <Text className="text-muted-foreground">As the cashier sees them on the price keypad.</Text>
        {error ? <Text className="text-destructive" accessibilityRole="alert">{error}</Text> : null}
        <Button onPress={onSave}><Text>Save quick discounts</Text></Button>
        <View className="mt-auto flex-row gap-2">
          <Button variant="outline" testID="cart-settings-restore" onPress={onReset}><Text>Restore Default Settings</Text></Button>
          <Button testID="cart-settings-close" onPress={() => setOpen(false)}><Text>Close</Text></Button>
        </View>
      </DialogContent>
    </Dialog>
  </>;
}
