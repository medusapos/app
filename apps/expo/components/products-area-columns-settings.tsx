import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import { Button, Dialog, DialogContent, DialogTitle, GripIcon, IconButton, Label, Switch, Text, XIcon } from '@tallyui/components';
import {
  moveProductsAreaColumn, PRODUCTS_AREA_COLUMNS, PRODUCTS_AREA_PRODUCT_LINES, productsAreaDropIndex, type ProductsAreaOrderedColumn,
  type useProductsAreaColumns,
} from '../lib/products-area-columns';
import { SlidersIcon } from './product-settings';

function SwitchRow({ testID, label, checked, onCheckedChange, className }: {
  testID: string; label: string; checked: boolean; onCheckedChange: (on: boolean) => void; className?: string;
}) {
  return <View className={`flex-row items-center justify-between gap-2${className ? ` ${className}` : ''}`}>
    <Label nativeID={`${testID}-label`}>{label}</Label>
    {/* TallyUI's Switch track sets no flex direction and react-native-web defaults to column, so
        items-center would center the thumb and the "on" translate would push it past the track. */}
    <Switch testID={testID} className="flex-row" aria-labelledby={`${testID}-label`} checked={checked} onCheckedChange={onCheckedChange} />
  </View>;
}

// v2's Products › Product Settings sheet: the Variations choice (the Sale's own setting, 'list' being Open in place and
// 'popover' Expanded rows here), then which columns the table shows. The Product column always shows; its indented
// sub-switches add lines under a variant row's name. Each Columns row's grip drags it to a new place (v2's order handles).
export function ProductsAreaColumnsButton({ settings, save, reset, order, saveOrder, variations, onVariationsChange }:
  ReturnType<typeof useProductsAreaColumns> & { variations: 'list' | 'popover'; onVariationsChange: (variations: 'list' | 'popover') => void }) {
  const [open, setOpen] = useState(false);
  // Web pointer drag, as TallyUI's camera resize handle: the row follows the pointer and the order is saved on release,
  // from the rows' laid-out boxes (transforms leave layout alone). Closing the sheet or unmounting ends a drag.
  const boxes = useRef<Partial<Record<ProductsAreaOrderedColumn, { y: number; height: number }>>>({});
  const [drag, setDrag] = useState<{ id: ProductsAreaOrderedColumn; dy: number } | null>(null);
  const dragCleanup = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => dragCleanup.current?.(), [open]);
  const startDrag = (id: ProductsAreaOrderedColumn, startY: number) => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    dragCleanup.current?.();
    let dy = 0;
    setDrag({ id, dy });
    const move = (event: PointerEvent) => { dy = event.clientY - startY; setDrag({ id, dy }); };
    const end = () => {
      dragCleanup.current?.();
      const from = order.indexOf(id);
      const target = productsAreaDropIndex(order.map((other) => boxes.current[other] ?? { y: 0, height: 0 }), from, dy);
      if (target !== from) saveOrder(moveProductsAreaColumn(order, id, target));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    dragCleanup.current = () => {
      dragCleanup.current = undefined;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      setDrag(null);
    };
  };
  return <>
    <IconButton testID="products-settings-button" accessibilityLabel="Product settings" onPress={() => setOpen(true)}><SlidersIcon /></IconButton>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent side="right" testID="products-settings-sheet" className="flex-col gap-4">
        <View className="flex-row items-center justify-between">
          <DialogTitle>Product Settings</DialogTitle>
          <IconButton testID="products-settings-x" accessibilityLabel="Close" className="h-11 w-11" onPress={() => setOpen(false)}>
            <View className="text-foreground"><XIcon size={24} /></View>
          </IconButton>
        </View>
        <ScrollView className="flex-1" contentContainerClassName="gap-4">
          <Text>Variations</Text>
          <View className="flex-row gap-2">
            {(['list', 'popover'] as const).map((choice) => {
              const selected = variations === choice;
              return <Pressable key={choice} testID={`products-settings-variations-${choice}`} accessibilityRole="button"
                accessibilityState={{ selected }} aria-selected={selected} onPress={() => onVariationsChange(choice)}
                className={`min-h-11 flex-1 items-center justify-center rounded-lg border-2 px-2 py-2 ${selected ? 'border-primary bg-muted' : 'border-border bg-card'}`}>
                <Text>{choice === 'list' ? 'Open in place' : 'Expanded rows'}</Text>
              </Pressable>;
            })}
          </View>
          <Text>Columns</Text>
          {order.map((id) => {
            const label = id === 'name' ? 'Product' : PRODUCTS_AREA_COLUMNS.find((column) => column.id === id)?.label ?? id;
            const moving = drag?.id === id;
            // One draggable unit per column; v2's Product is a label with no switch, its sub-switches indented under it.
            return <View key={id} className={`gap-4${moving ? ' bg-card' : ''}`}
              style={moving ? { transform: [{ translateY: drag.dy }], zIndex: 1 } : undefined}
              onLayout={({ nativeEvent }) => { boxes.current[id] = nativeEvent.layout; }}>
              <View className="flex-row items-center gap-2">
                {/* touch-none: a touch drag on the grip moves the row, not the sheet. */}
                <View testID={`products-settings-drag-${id}`} accessibilityLabel={`Drag to move ${label}`}
                  className={`self-stretch justify-center text-muted-foreground web:touch-none ${moving ? 'web:cursor-grabbing' : 'web:cursor-grab'}`}
                  onPointerDown={(event) => { event.preventDefault(); startDrag(id, event.nativeEvent.clientY); }}>
                  <GripIcon size={16} />
                </View>
                {id === 'name' ? <View testID="products-settings-product" className="flex-1"><Label>Product</Label></View>
                  : <SwitchRow className="flex-1" testID={`products-settings-column-${id}`} label={label} checked={settings[id]}
                    onCheckedChange={(on) => save({ ...settings, [id]: on })} />}
              </View>
              {id === 'name' ? PRODUCTS_AREA_PRODUCT_LINES.map((line) => <SwitchRow key={line.id} className="pl-12" label={line.label}
                testID={`products-settings-product-${line.id.slice('product'.length).toLowerCase()}`} checked={settings[line.id]}
                onCheckedChange={(on) => save({ ...settings, [line.id]: on })} />) : null}
            </View>;
          })}
        </ScrollView>
        <View className="flex-row justify-between gap-2">
          {/* v2: Restore puts the columns back; Variations stays as chosen. */}
          <Button variant="outline" testID="products-settings-restore" onPress={reset}><Text>Restore Default Settings</Text></Button>
          <Button variant="outline" testID="products-settings-close" onPress={() => setOpen(false)}><Text>Close</Text></Button>
        </View>
      </DialogContent>
    </Dialog>
  </>;
}
