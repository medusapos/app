import { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { Circle, Line } from 'react-native-svg';
import { Button, createSvgIcon, Dialog, DialogContent, DialogTitle, IconButton, Input, Label, Switch, Text, XIcon } from '@tallyui/components';
import type { CartSettings, useCartSettings } from '../lib/cart-settings';

type Column = keyof CartSettings['columns'];
// v2's Columns rows in order: [column, flag, label]; split and name's SKU are indented under their column.
const COLUMN_ROWS: [Column, 'show' | 'split' | 'sku', string][] = [['quantity', 'show', 'Qty'], ['quantity', 'split', 'Split'],
  ['image', 'show', 'Image'], ['name', 'show', 'Name'], ['name', 'sku', 'SKU'], ['sku', 'show', 'SKU'], ['price', 'show', 'Price'],
  ['total', 'show', 'Total']];
// TallyUI's default for a missing flag: Qty, Name, Price and Total show; everything else is off.
const SHOWN_BY_DEFAULT: Column[] = ['quantity', 'name', 'price', 'total'];

const SlidersIcon = createSvgIcon('SlidersIcon', () => <>
  <Line x1={3} y1={6} x2={21} y2={6} /><Circle cx={8} cy={6} r={2} />
  <Line x1={3} y1={12} x2={21} y2={12} /><Circle cx={16} cy={12} r={2} />
  <Line x1={3} y1={18} x2={21} y2={18} /><Circle cx={8} cy={18} r={2} />
</>);

export function CartSettingsButton({ settings, save, reset }: ReturnType<typeof useCartSettings>) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Enter and then blur both land here; the second call finds no key open and does nothing.
  function commit() {
    if (editing === null) return;
    const list = settings.quickDiscounts.map((value, i) => (i === editing ? Number(draft.trim()) : value));
    try { save({ ...settings, quickDiscounts: list }); setError(null); }
    catch (err) { setError((err as Error).message); }
    setEditing(null);
  }
  function edit(i: number) {
    commit(); setDraft(String(settings.quickDiscounts[i])); setEditing(i);
  }
  function onReset() {
    reset(); setEditing(null); setError(null);
  }
  return <>
    <IconButton testID="cart-settings-button" accessibilityLabel="Cart settings" onPress={() => setOpen(true)}><SlidersIcon /></IconButton>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent side="right" testID="cart-settings-sheet" className="flex-col gap-4">
        <View className="flex-row items-center justify-between">
          <DialogTitle>Cart Settings</DialogTitle>
          <IconButton testID="cart-settings-x" accessibilityLabel="Close" className="h-11 w-11" onPress={() => setOpen(false)}>
            <View className="text-foreground"><XIcon size={24} /></View>
          </IconButton>
        </View>
        <ScrollView className="flex-1" contentContainerClassName="gap-4">
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
        {/* The price keypad's own quick-discount keys (TallyUI QuickDiscountKeys); a tapped key becomes its field. */}
        <View className="flex-row gap-2">
          {settings.quickDiscounts.map((value, i) => editing === i
            ? <View key={i} className="flex-1"><Input><Input.Field accessibilityLabel={`Quick discount ${i + 1}`}
                keyboardType="number-pad" autoFocus selectTextOnFocus value={draft} onChangeText={setDraft}
                onSubmitEditing={commit} onBlur={commit} /></Input></View>
            : <Pressable key={i} testID={`cart-settings-discount-${i + 1}`} accessibilityRole="button"
                accessibilityLabel={`Edit quick discount ${i + 1} (${value}%)`} onPress={() => edit(i)}
                className="rounded-md border border-border px-3 py-2 min-h-11 items-center justify-center flex-1 bg-card">
                <Text className="text-foreground">{`−${value}%`}</Text>
              </Pressable>)}
        </View>
        <Text className="text-muted-foreground">As the cashier sees them on the price keypad. Tap a key to change it.</Text>
        {error ? <Text className="text-destructive" accessibilityRole="alert">{error}</Text> : null}
        <Text>Columns</Text>
        {COLUMN_ROWS.map(([column, flag, label]) => {
          const id = `cart-settings-column-${column}${flag === 'show' ? '' : `-${flag}`}`;
          const value = (settings.columns[column] as Record<string, boolean | undefined> | undefined)?.[flag];
          const checked = value ?? (flag === 'show' && SHOWN_BY_DEFAULT.includes(column));
          return <View key={id} className={`flex-row items-center justify-between gap-2${flag === 'show' ? '' : ' pl-8'}`}>
            <Label nativeID={`${id}-label`}>{label}</Label>
            <Switch testID={id} aria-labelledby={`${id}-label`} checked={checked} onCheckedChange={(on) => save({ ...settings,
              columns: { ...settings.columns, [column]: { ...settings.columns[column], [flag]: on } } })} />
          </View>;
        })}
        </ScrollView>
        <View className="flex-row justify-between gap-2">
          <Button variant="outline" testID="cart-settings-restore" onPress={onReset}><Text>Restore Default Settings</Text></Button>
          <Button variant="outline" testID="cart-settings-close" onPress={() => setOpen(false)}><Text>Close</Text></Button>
        </View>
      </DialogContent>
    </Dialog>
  </>;
}
