import { useRef, useState } from 'react';
import { View } from 'react-native';
import { Line, Path } from 'react-native-svg';
import {
  createSvgIcon, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, IconButton, Text,
} from '@tallyui/components';

// lucide refresh-cw
const RefreshIcon = createSvgIcon('RefreshIcon', () => <><Path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
  <Path d="M21 3v5h-5" /><Path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><Path d="M8 16H3v5" /></>);
// lucide trash-2
const TrashIcon = createSvgIcon('TrashIcon', () => <><Path d="M3 6h18" /><Path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
  <Path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" /><Line x1={10} y1={11} x2={10} y2={17} /><Line x1={14} y1={11} x2={14} y2={17} /></>);

// The trigger's ref carries the primitive's open(), which also measures the trigger so native can place the menu.
type TriggerHandle = View & { open?: () => void };

/**
 * v2's catalogue sync arrow: a tap syncs; a press and hold (or a right click on web) opens Sync and Clear and Refresh.
 * The menu is fully controlled: the trigger's own open on a tap is ignored, so only a long press opens it.
 */
export function CatalogueSyncButton({ onSync, onClearAndRefresh, syncing }: {
  onSync: () => void; onClearAndRefresh: () => void; syncing: boolean;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<TriggerHandle>(null);
  const opening = useRef(false);
  const openMenu = () => {
    opening.current = true;
    trigger.current?.open?.();
    opening.current = false;
  };
  // react-native-web forwards onContextMenu; RN's Pressable types do not name it.
  const contextMenu = { onContextMenu: (event: { preventDefault(): void }) => { event.preventDefault(); openMenu(); } };
  return <DropdownMenu open={open} onOpenChange={(next) => { if (!next || opening.current) setOpen(next); }}>
    <DropdownMenuTrigger ref={trigger} asChild onPress={onSync}>
      <IconButton testID="catalogue-sync" accessibilityLabel="Sync products" accessibilityHint="Press and hold for more options"
        aria-busy={syncing} delayLongPress={400} onLongPress={openMenu} {...contextMenu}>
        <View className="text-muted-foreground" style={{ opacity: syncing ? 0.5 : 1 }}><RefreshIcon size={16} /></View>
      </IconButton>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end">
      <DropdownMenuItem testID="catalogue-sync-now" className="gap-2" onPress={onSync}>
        <View className="text-foreground"><RefreshIcon size={16} /></View><Text>Sync</Text>
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem testID="catalogue-clear-refresh" className="gap-2" onPress={onClearAndRefresh}>
        <View className="text-destructive"><TrashIcon size={16} /></View><Text className="text-destructive">Clear and Refresh</Text>
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>;
}
