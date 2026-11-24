import { useEffect, useState } from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import { Path } from 'react-native-svg';
import {
  Button, createSvgIcon, Dialog, DialogContent, DialogTitle, IconButton, Label, Receipt, Tabs, TabsContent, TabsList,
  TabsTrigger, Text, Textarea, XIcon,
} from '@tallyui/components';
import type { SentOrder } from '@tallyui/pos';
import { formatReceiptDate } from '../lib/format-date';
import { receiptTaxLabel } from '../lib/order-detail';
import { sheetEdge, sheetEdgeClass } from '../lib/sheet-edge';
import { injectReceiptPrintStyle } from './order-detail-sheet';

// A sticky note outline, as v2's cart note row shows.
const NoteIcon = createSvgIcon('NoteIcon', () => <><Path d="M13 20l7-7" />
  <Path d="M13 20v-6a1 1 0 0 1 1-1h6V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h7" /></>);
// A printer outline, as v2's Print button shows.
const PrinterIcon = createSvgIcon('PrinterIcon', () => <><Path d="M6 9V3h12v6" />
  <Path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" /><Path d="M6 14h12v7H6z" /></>);

/** v2's cart note row (testID cart-note-row): the note's icon and text on one line; pressing it opens the note sheet. */
export function CartNoteRow({ note, onPress }: { note: string; onPress: () => void }) {
  return <Pressable testID="cart-note-row" accessibilityRole="button" accessibilityLabel={`Order note: ${note}`} onPress={onPress}
    className="min-h-11 flex-row items-center gap-2">
    <View className="text-muted-foreground"><NoteIcon size={16} /></View>
    <Text testID="cart-note-text" numberOfLines={1} className="min-w-0 flex-1 text-sm text-foreground">{note}</Text>
  </Pressable>;
}

/**
 * v2's Order details side sheet (DEMO-PARITY row 04c.3). Form holds the order note: each change goes to the sale as typed,
 * so emptying the field removes the note. JSON shows the open sale read-only. Print (web only) swaps in the sale's draft
 * receipt, Close and ✕ close, and Void (lines and no payments) closes the sheet and asks first, as the ⋮ menu's Void does.
 * As in v2 it opens over the products, away from the cart. v2's Sync order, Currency, Tax exempt and Custom fields are not
 * here: the open sale is local until checkout, so the 3.20.1 connector has nothing truthful to sync or store them in.
 */
export function CartNoteSheet({ open, onOpenChange, value, onChangeText, cartSide, phone, order, store, cashier, registerId, onVoid }: {
  open: boolean; onOpenChange: (open: boolean) => void; value: string; onChangeText: (text: string) => void;
  cartSide: 'left' | 'right'; phone: boolean; order: SentOrder; store: { name: string; address?: string };
  cashier: string; registerId: string; onVoid?: () => void;
}) {
  const edge = sheetEdge(cartSide, phone);
  const [tab, setTab] = useState('form');
  const [receipt, setReceipt] = useState(false);
  // Each opening starts on Form, not the receipt or JSON.
  useEffect(() => { if (!open) { setTab('form'); setReceipt(false); } }, [open]);
  useEffect(() => { if (receipt) injectReceiptPrintStyle(); }, [receipt]);
  // The same rule as Receipt's own Print receipt button.
  const canPrint = Platform.OS === 'web' && typeof window !== 'undefined' && typeof window.print === 'function';
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent side="right" testID="cart-note-sheet" dataSet={{ side: edge }} className={"flex-col gap-4 " + sheetEdgeClass(edge)}>
      <View className="flex-row items-center justify-between">
        <DialogTitle>Order details</DialogTitle>
        <IconButton testID="cart-note-x" accessibilityLabel="Close" className="h-11 w-11" onPress={() => onOpenChange(false)}>
          <View className="text-foreground"><XIcon size={24} /></View>
        </IconButton>
      </View>
      {receipt ? <ScrollView testID="cart-note-receipt-view" dataSet={{ print: 'receipt' }} className="flex-1">
        <Receipt order={order} store={store} cashier={cashier} registerId={registerId} taxLabel={receiptTaxLabel}
          formatDate={formatReceiptDate} doneLabel="Back" newSale={() => setReceipt(false)} />
      </ScrollView> : <Tabs value={tab} onValueChange={setTab}>
        <View className="flex-1 gap-2">
          {/* TallyUI's TabsList has inline-flex but no flex-row, so a View stacks its triggers in a column. */}
          <TabsList className="w-full flex-row">
            <TabsTrigger value="form" testID="cart-order-tab-form" className="flex-1"><Text>Form</Text></TabsTrigger>
            <TabsTrigger value="json" testID="cart-order-tab-json" className="flex-1"><Text>JSON</Text></TabsTrigger>
          </TabsList>
          <TabsContent value="form" className="flex-1">
            <ScrollView className="flex-1" contentContainerClassName="gap-2" keyboardShouldPersistTaps="handled">
              <Label nativeID="cart-note-label">Note</Label>
              <Textarea testID="cart-note-field" multiline autoFocus value={value} onChangeText={onChangeText}
                placeholder="Order note" accessibilityLabel="Order note" />
            </ScrollView>
          </TabsContent>
          <TabsContent value="json" className="flex-1">
            <ScrollView className="flex-1 rounded-md border border-border p-2">
              <Text testID="cart-order-json" selectable className="font-mono text-xs text-foreground">{JSON.stringify(order, null, 2)}</Text>
            </ScrollView>
          </TabsContent>
        </View>
      </Tabs>}
      <View testID="cart-note-footer" dataSet={{ layout: 'stacked' }} className="flex-col gap-2">
        {canPrint && !receipt ? <Button variant="outline" testID="cart-note-print" className="w-full flex-row gap-2" onPress={() => setReceipt(true)}>
          <View className="text-foreground"><PrinterIcon size={16} /></View><Text>Print</Text>
        </Button> : null}
        <Button variant="outline" testID="cart-note-close" className="w-full" onPress={() => onOpenChange(false)}><Text>Close</Text></Button>
        {onVoid ? <Button variant="outline" testID="cart-note-void" className="w-full border-destructive"
          onPress={() => { onOpenChange(false); onVoid(); }}><Text className="text-destructive">Void</Text></Button> : null}
      </View>
    </DialogContent>
  </Dialog>;
}
