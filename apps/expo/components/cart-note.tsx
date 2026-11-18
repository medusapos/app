import { Pressable, ScrollView, View } from 'react-native';
import { Path } from 'react-native-svg';
import { Button, createSvgIcon, Dialog, DialogContent, DialogTitle, IconButton, Label, Text, Textarea, XIcon } from '@tallyui/components';
import { sheetEdge, sheetEdgeClass } from '../lib/sheet-edge';

// A sticky note outline, as v2's cart note row shows.
const NoteIcon = createSvgIcon('NoteIcon', () => <><Path d="M13 20l7-7" />
  <Path d="M13 20v-6a1 1 0 0 1 1-1h6V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h7" /></>);

/** The cart's "Add order note" link, in the look of TallyUI's collapsed CartNoteInput, opening the note sheet. */
export function CartNoteLink({ onPress }: { onPress: () => void }) {
  return <Pressable testID="cart-note-add" accessibilityRole="button" onPress={onPress} className="flex-row items-center px-3 py-2">
    <Text className="text-xs text-primary">Add order note</Text>
  </Pressable>;
}

/** v2's cart note row (testID cart-note-row): the note's icon and text on one line; pressing it opens the note sheet. */
export function CartNoteRow({ note, onPress }: { note: string; onPress: () => void }) {
  return <Pressable testID="cart-note-row" accessibilityRole="button" accessibilityLabel={`Order note: ${note}`} onPress={onPress}
    className="min-h-11 flex-row items-center gap-2">
    <View className="text-muted-foreground"><NoteIcon size={16} /></View>
    <Text testID="cart-note-text" numberOfLines={1} className="min-w-0 flex-1 text-sm text-foreground">{note}</Text>
  </Pressable>;
}

/**
 * v2's Order details side sheet (DEMO-PARITY row 04c.3), holding the order note: each change goes to the sale as typed,
 * so emptying the field removes the note; Close and ✕ close. As in v2 it opens over the products, away from the cart.
 */
export function CartNoteSheet({ open, onOpenChange, value, onChangeText, cartSide, phone }: {
  open: boolean; onOpenChange: (open: boolean) => void; value: string; onChangeText: (text: string) => void;
  cartSide: 'left' | 'right'; phone: boolean;
}) {
  const edge = sheetEdge(cartSide, phone);
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent side="right" testID="cart-note-sheet" dataSet={{ side: edge }} className={"flex-col gap-4 " + sheetEdgeClass(edge)}>
      <View className="flex-row items-center justify-between">
        <DialogTitle>Order details</DialogTitle>
        <IconButton testID="cart-note-x" accessibilityLabel="Close" className="h-11 w-11" onPress={() => onOpenChange(false)}>
          <View className="text-foreground"><XIcon size={24} /></View>
        </IconButton>
      </View>
      <ScrollView className="flex-1" contentContainerClassName="gap-2" keyboardShouldPersistTaps="handled">
        <Label nativeID="cart-note-label">Note</Label>
        <Textarea testID="cart-note-field" multiline autoFocus value={value} onChangeText={onChangeText}
          placeholder="Order note" accessibilityLabel="Order note" />
      </ScrollView>
      <View testID="cart-note-footer" className="flex-row justify-end gap-2">
        <Button variant="outline" testID="cart-note-close" onPress={() => onOpenChange(false)}><Text>Close</Text></Button>
      </View>
    </DialogContent>
  </Dialog>;
}
