import { createContext, useContext, type ReactNode } from 'react';
import { View } from 'react-native';
import { SettingsGroup as BoxedGroup, SettingsRow as BoxedRow, type SettingsGroupProps, type SettingsRowProps } from '@tallyui/components';
import { cn } from '@tallyui/theme';
import { AppText as Text } from '../components/app-text';

// Wide sections have flat groups with optional dividers; phones keep TallyUI's separate boxed groups.
export const SettingsFlatContext = createContext(false);

export function SettingsGroup({ title, description, children, className, divider, ...viewProps }: SettingsGroupProps & { divider?: boolean }) {
  const flat = useContext(SettingsFlatContext);
  if (!flat) return <BoxedGroup title={title} description={description} className={className} {...viewProps}>{children}</BoxedGroup>;
  // -mx-4 undoes the section card's p-4, so the title, the rows and their notes keep their px-4 and line up under
  // the card's title, as v2's do.
  return <View className={cn('-mx-4 gap-1', divider && '-mt-3', className)} {...viewProps}>
    {divider ? <View testID="settings-group-divider" aria-hidden className="mx-4 mb-2 h-px bg-border" /> : null}
    <View className="px-4 py-2">
      <Text className="text-sm font-semibold text-foreground">{title}</Text>
      {description ? <Text className="text-xs text-muted-foreground">{description}</Text> : null}
    </View>
    {children}
  </View>;
}

/** `divider` draws the line above a row in a boxed group; flat rows have none, as in v2. */
export function SettingsRow({ label, description, action, aside, divider, className, ...viewProps }: SettingsRowProps & { aside?: ReactNode; divider?: boolean }) {
  const flat = useContext(SettingsFlatContext);
  if (!flat) return <BoxedRow label={label} description={description} action={aside == null ? action : <View className="flex-row items-center gap-3">{action}{aside}</View>}
    className={cn(divider && 'border-t border-border', className)} {...viewProps} />;
  // The value starts beside the label; an aside gets its own column at the row's right edge.
  return <View className={cn('flex-row items-center gap-3 px-4 py-3', className)} {...viewProps}>
    <View className="w-56 shrink-0 gap-0.5">
      <Text className="text-sm font-medium text-foreground">{label}</Text>
      {description ? <Text className="text-xs text-muted-foreground">{description}</Text> : null}
    </View>
    {action ? <View className="min-w-0 flex-1 items-start">{action}</View> : null}
    {aside == null ? null : <View className="shrink-0 flex-row items-center">{aside}</View>}
  </View>;
}
