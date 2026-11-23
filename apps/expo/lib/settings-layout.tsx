import { createContext, useContext } from 'react';
import { View } from 'react-native';
import { SettingsGroup as BoxedGroup, SettingsRow as BoxedRow, type SettingsGroupProps, type SettingsRowProps } from '@tallyui/components';
import { cn } from '@tallyui/theme';
import { AppText as Text } from '../components/app-text';

// True inside the wide Settings' section card. There, as in v2, a group is flat rows under its title, each value in a
// column beside its label; a phone's section page keeps TallyUI's boxed group, whose own card has no className.
export const SettingsFlatContext = createContext(false);

export function SettingsGroup({ title, description, children, className, ...viewProps }: SettingsGroupProps) {
  const flat = useContext(SettingsFlatContext);
  if (!flat) return <BoxedGroup title={title} description={description} className={className} {...viewProps}>{children}</BoxedGroup>;
  // -mx-4 undoes the section card's p-4, so the title, the rows and their notes keep their px-4 and line up under
  // the card's title, as v2's do.
  return <View className={cn('-mx-4 gap-1', className)} {...viewProps}>
    <View className="px-4 py-2">
      <Text className="text-sm font-semibold text-foreground">{title}</Text>
      {description ? <Text className="text-xs text-muted-foreground">{description}</Text> : null}
    </View>
    {children}
  </View>;
}

/** `divider` draws the line above a row in a boxed group; flat rows have none, as in v2. */
export function SettingsRow({ label, description, action, divider, className, ...viewProps }: SettingsRowProps & { divider?: boolean }) {
  const flat = useContext(SettingsFlatContext);
  if (!flat) return <BoxedRow label={label} description={description} action={action}
    className={cn(divider && 'border-t border-border', className)} {...viewProps} />;
  // v2's label column is about 200 px; the value, its "Open ↗" or a wide control starts right after it.
  return <View className={cn('flex-row items-center gap-3 px-4 py-3', className)} {...viewProps}>
    <View className="w-56 shrink-0 gap-0.5">
      <Text className="text-sm font-medium text-foreground">{label}</Text>
      {description ? <Text className="text-xs text-muted-foreground">{description}</Text> : null}
    </View>
    {action ? <View className="min-w-0 flex-1 items-start">{action}</View> : null}
  </View>;
}
