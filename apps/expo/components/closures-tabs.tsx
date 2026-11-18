import type { JSX } from 'react';
import { View } from 'react-native';
import { Text, ToggleGroup, ToggleGroupItem } from '@tallyui/components';
import { AppText } from './app-text';

export type ClosuresTab = 'all' | 'open' | 'closed';

const TABS: { value: ClosuresTab; label: string }[] = [
  { value: 'all', label: 'All' }, { value: 'open', label: 'Open' }, { value: 'closed', label: 'Closed' },
];

/** v2's segmented All | Open | Closed above the Closures list, with the shown sessions' count at the right. */
export function ClosuresTabs({ value, onChange, count }: {
  value: ClosuresTab; onChange: (tab: ClosuresTab) => void; count: number;
}): JSX.Element {
  return <View testID="closures-tabs" className="flex-row flex-wrap items-center justify-between gap-2">
    <ToggleGroup type="single" variant="outline" aria-label="Sessions" value={value}
      onValueChange={(next) => { if (next) onChange(next as ClosuresTab); }}>
      {TABS.map((tab) => <ToggleGroupItem key={tab.value} value={tab.value} testID={`closures-tab-${tab.value}`}
        className={value === tab.value ? 'bg-accent' : ''}>
        <Text>{tab.label}</Text>
      </ToggleGroupItem>)}
    </ToggleGroup>
    <AppText testID="closures-count" className="text-muted-foreground">{count === 1 ? '1 session' : `${count} sessions`}</AppText>
  </View>;
}
