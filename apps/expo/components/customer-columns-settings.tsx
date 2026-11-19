import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { Circle, Line } from 'react-native-svg';
import { Button, createSvgIcon, Dialog, DialogContent, DialogTitle, IconButton, Label, Switch, Text, XIcon } from '@tallyui/components';
import { CUSTOMER_COLUMNS, type useCustomerColumns } from '../lib/customer-columns';

const SlidersIcon = createSvgIcon('SlidersIcon', () => <>
  <Line x1={3} y1={6} x2={21} y2={6} /><Circle cx={8} cy={6} r={2} />
  <Line x1={3} y1={12} x2={21} y2={12} /><Circle cx={16} cy={12} r={2} />
  <Line x1={3} y1={18} x2={21} y2={18} /><Circle cx={8} cy={18} r={2} />
</>);

// v2's customers table settings sheet: which columns the table shows.
export function CustomerColumnsButton({ settings, save, reset }: ReturnType<typeof useCustomerColumns>) {
  const [open, setOpen] = useState(false);
  const shown = CUSTOMER_COLUMNS.filter(({ id }) => settings[id]).length;
  return <>
    <IconButton testID="customers-settings-button" accessibilityLabel="Customer settings" onPress={() => setOpen(true)}><SlidersIcon /></IconButton>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent side="right" testID="customers-settings-sheet" className="flex-col gap-4">
        <View className="flex-row items-center justify-between">
          <DialogTitle>Customer Settings</DialogTitle>
          <IconButton testID="customers-settings-x" accessibilityLabel="Close" className="h-11 w-11" onPress={() => setOpen(false)}>
            <View className="text-foreground"><XIcon size={24} /></View>
          </IconButton>
        </View>
        <ScrollView className="flex-1" contentContainerClassName="gap-4">
          <Text>Columns</Text>
          {CUSTOMER_COLUMNS.map(({ id, label }) => {
            const testID = `customers-settings-column-${id}`;
            const last = settings[id] && shown === 1;
            return <View key={id} className="flex-row items-center justify-between gap-2">
              <Label nativeID={`${testID}-label`}>{label}</Label>
              {/* TallyUI's Switch track sets no flex direction and react-native-web defaults to column, so
                  items-center would center the thumb and the "on" translate would push it past the track. */}
              <Switch testID={testID} className="flex-row" aria-labelledby={`${testID}-label`} checked={settings[id]} disabled={last}
                onCheckedChange={(on) => save({ ...settings, [id]: on })} />
            </View>;
          })}
          <Text className="text-muted-foreground">At least one column always shows.</Text>
        </ScrollView>
        <View className="flex-row justify-between gap-2">
          <Button variant="outline" testID="customers-settings-restore" onPress={reset}><Text>Restore Default Settings</Text></Button>
          <Button variant="outline" testID="customers-settings-close" onPress={() => setOpen(false)}><Text>Close</Text></Button>
        </View>
      </DialogContent>
    </Dialog>
  </>;
}
