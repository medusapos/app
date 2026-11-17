import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { DateRangeMenu } from '@tallyui/components';
import type { ClosureFilters } from '../lib/reports';

type Option = { value: string; label: string };

/** Same look and behaviour as TallyUI's ChoiceSelect (inside SalesFiltersBar, not exported). */
function ChoiceSelect({ id, value, options, onChange }: { id: string; value: string; options: Option[]; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const chosen = options.find((option) => option.value === value);
  return <View className="gap-1">
    <Pressable testID={id} accessibilityRole="button" onPress={() => setOpen(!open)}
      className="rounded-md border border-border bg-card px-3 py-2">
      <Text className="text-sm text-foreground">{chosen?.label ?? value}</Text>
    </Pressable>
    {open ? <View className="rounded-md border border-border bg-card py-1">
      {options.map((option) => <Pressable key={option.value} testID={`${id}-option-${option.value}`} accessibilityRole="radio"
        accessibilityState={{ checked: option.value === value }}
        className={option.value === value ? 'px-3 py-2 bg-muted' : 'px-3 py-2'}
        onPress={() => { setOpen(false); onChange(option.value); }}>
        <Text className="text-sm text-foreground">{option.label}</Text>
      </Pressable>)}
    </View> : null}
  </View>;
}

/** v2's Closures filter row: period, store · register, cashier. */
export function ClosureFiltersBar({ filters, onChange, registerOptions, cashierOptions }: {
  filters: ClosureFilters; onChange: (next: ClosureFilters) => void; registerOptions: Option[]; cashierOptions: Option[];
}) {
  return <View testID="closures-filters" className="flex-row flex-wrap items-start gap-2">
    <DateRangeMenu testID="closures-period" timezone="device" value={{ preset: filters.preset, range: filters.range }}
      onChange={(next) => onChange({ ...filters, preset: next.preset, range: next.range })} />
    <ChoiceSelect id="closures-register" value={filters.registerId ?? ''} options={registerOptions}
      onChange={(registerId) => onChange({ ...filters, registerId })} />
    <ChoiceSelect id="closures-cashier" value={filters.cashierId ?? 'all'}
      options={[{ value: 'all', label: 'All cashiers' }, ...cashierOptions]}
      onChange={(value) => onChange({ ...filters, cashierId: value === 'all' ? null : value })} />
  </View>;
}
