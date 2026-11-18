import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { Button, Dialog, DialogContent, DialogTitle, IconButton, Label, Switch, Text, XIcon } from '@tallyui/components';
import { PRODUCTS_AREA_COLUMNS, type useProductsAreaColumns } from '../lib/products-area-columns';
import { SlidersIcon } from './product-settings';

// v2's Products › Product Settings sheet: which columns the table shows. The Product column always shows.
export function ProductsAreaColumnsButton({ settings, save, reset }: ReturnType<typeof useProductsAreaColumns>) {
  const [open, setOpen] = useState(false);
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
          <Text>Columns</Text>
          {PRODUCTS_AREA_COLUMNS.map(({ id, label }) => {
            const testID = `products-settings-column-${id}`;
            return <View key={id} className="flex-row items-center justify-between gap-2">
              <Label nativeID={`${testID}-label`}>{label}</Label>
              <Switch testID={testID} aria-labelledby={`${testID}-label`} checked={settings[id]}
                onCheckedChange={(on) => save({ ...settings, [id]: on })} />
            </View>;
          })}
        </ScrollView>
        <View className="flex-row justify-between gap-2">
          <Button variant="outline" testID="products-settings-restore" onPress={reset}><Text>Restore Default Settings</Text></Button>
          <Button variant="outline" testID="products-settings-close" onPress={() => setOpen(false)}><Text>Close</Text></Button>
        </View>
      </DialogContent>
    </Dialog>
  </>;
}
