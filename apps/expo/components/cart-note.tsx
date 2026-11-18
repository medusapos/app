import { Pressable, View } from 'react-native';
import { Path } from 'react-native-svg';
import { Button, createSvgIcon, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, Text, Textarea } from '@tallyui/components';

// A sticky note outline, as v2's cart note row shows.
const NoteIcon = createSvgIcon('NoteIcon', () => <><Path d="M13 20l7-7" />
  <Path d="M13 20v-6a1 1 0 0 1 1-1h6V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h7" /></>);

/** The cart's "Add order note" link, in the look of TallyUI's collapsed CartNoteInput, opening the note dialog. */
export function CartNoteLink({ onPress }: { onPress: () => void }) {
  return <Pressable testID="cart-note-add" accessibilityRole="button" onPress={onPress} className="flex-row items-center px-3 py-2">
    <Text className="text-xs text-primary">Add order note</Text>
  </Pressable>;
}

/** v2's cart note row (testID cart-note-row): the note's icon and text on one line; pressing it opens the note dialog. */
export function CartNoteRow({ note, onPress }: { note: string; onPress: () => void }) {
  return <Pressable testID="cart-note-row" accessibilityRole="button" accessibilityLabel={`Order note: ${note}`} onPress={onPress}
    className="min-h-11 flex-row items-center gap-2">
    <View className="text-muted-foreground"><NoteIcon size={16} /></View>
    <Text testID="cart-note-text" numberOfLines={1} className="min-w-0 flex-1 text-sm text-foreground">{note}</Text>
  </Pressable>;
}

/** The order note's editor: each change goes to the sale as typed; Clear empties the note, Done closes. */
export function CartNoteDialog({ open, onOpenChange, value, onChangeText }: {
  open: boolean; onOpenChange: (open: boolean) => void; value: string; onChangeText: (text: string) => void;
}) {
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent testID="cart-note-dialog">
      <DialogHeader><DialogTitle>Order note</DialogTitle></DialogHeader>
      <Textarea testID="cart-note-field" multiline autoFocus value={value} onChangeText={onChangeText}
        placeholder="Order note" accessibilityLabel="Order note" />
      <DialogFooter>
        {value !== '' && <Button variant="outline" onPress={() => { onChangeText(''); onOpenChange(false); }}><Text>Clear</Text></Button>}
        <Button onPress={() => onOpenChange(false)}><Text>Done</Text></Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
