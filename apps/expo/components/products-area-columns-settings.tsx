import { Fragment, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { Button, Dialog, DialogContent, DialogTitle, IconButton, Label, Switch, Text, XIcon } from '@tallyui/components';
import { PRODUCTS_AREA_COLUMNS, PRODUCTS_AREA_PRODUCT_LINES, type useProductsAreaColumns } from '../lib/products-area-columns';
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

// v2's Products › Product Settings sheet: which columns the table shows. The Product column always shows; its
// indented sub-switches add lines under a variant row's name.
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
          {PRODUCTS_AREA_COLUMNS.map(({ id, label }) => <Fragment key={id}>
            <SwitchRow testID={`products-settings-column-${id}`} label={label} checked={settings[id]}
              onCheckedChange={(on) => save({ ...settings, [id]: on })} />
            {/* v2 lists Product after ID: a label with no switch, then its sub-switches indented. */}
            {id === 'id' ? <>
              <View testID="products-settings-product"><Label>Product</Label></View>
              {PRODUCTS_AREA_PRODUCT_LINES.map((line) => <SwitchRow key={line.id} className="pl-6" label={line.label}
                testID={`products-settings-product-${line.id.slice('product'.length).toLowerCase()}`} checked={settings[line.id]}
                onCheckedChange={(on) => save({ ...settings, [line.id]: on })} />)}
            </> : null}
          </Fragment>)}
        </ScrollView>
        <View className="flex-row justify-between gap-2">
          <Button variant="outline" testID="products-settings-restore" onPress={reset}><Text>Restore Default Settings</Text></Button>
          <Button variant="outline" testID="products-settings-close" onPress={() => setOpen(false)}><Text>Close</Text></Button>
        </View>
      </DialogContent>
    </Dialog>
  </>;
}
