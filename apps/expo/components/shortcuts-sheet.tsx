import { Pressable, View } from 'react-native';
import { Dialog, DialogContent, DialogTitle, Text } from '@tallyui/components';
import { chordLabel, otherOverlayOpen, runShortcut, SHORTCUTS, useAvailableShortcuts, type ShortcutId } from '../lib/shortcuts';

const isMac = () => typeof navigator !== 'undefined' && /Mac/.test(`${navigator.platform} ${navigator.userAgent}`);

function KeyCaps({ keys }: { keys: string[] }) {
  return <View className="flex-row gap-1">
    {keys.map((key) => <View key={key} className="min-w-7 items-center rounded border border-border bg-card px-1.5 py-0.5">
      <Text className="text-xs text-foreground">{key}</Text>
    </View>)}
  </View>;
}

// v2's hotkeys help sheet (help-sheet.tsx l.50-94): each shortcut with its key caps, greyed while it cannot run; a row
// press closes the sheet and then runs it, as its chord does (only help over another dialog). Dialog closes on Escape.
export function ShortcutsSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const available = useAvailableShortcuts();
  const mac = isMac();
  const beneath = open && otherOverlayOpen();
  const press = (id: ShortcutId) => {
    onOpenChange(false);
    if (id !== 'help.open') setTimeout(() => runShortcut(id), 0);
  };
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent testID="shortcuts-sheet" showClose className="w-full max-w-md gap-3">
      <DialogTitle className="text-lg font-semibold">Keyboard shortcuts</DialogTitle>
      <View className="gap-1">
        {SHORTCUTS.map(({ id, label }) => {
          const on = available.has(id) && (id === 'help.open' || !beneath);
          return <Pressable key={id} testID={`shortcuts-row-${id}`} accessibilityRole="button" aria-disabled={!on || undefined}
            disabled={!on} onPress={() => press(id)}
            className={`flex-row items-center justify-between rounded-md px-2 py-2 ${on ? 'hover:bg-accent' : 'opacity-50'}`}>
            <Text className="text-foreground">{label}</Text>
            <KeyCaps keys={chordLabel(id, mac)} />
          </Pressable>;
        })}
        <View testID="shortcuts-row-escape" className="flex-row items-center justify-between border-t border-border px-2 pt-3">
          <Text className="text-muted-foreground">Close a sheet</Text>
          <KeyCaps keys={['Esc']} />
        </View>
      </View>
    </DialogContent>
  </Dialog>;
}
