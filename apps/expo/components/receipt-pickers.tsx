import { useState, type ReactNode } from 'react';
import { View } from 'react-native';
import { Button, orderReference, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Text } from '@tallyui/components';
import { buildReceiptData, type PosOrder, type PrinterProfile, type ReceiptPaper, type SentOrder } from '@tallyui/pos';
import { printSalePage, RECEIPT_TEMPLATES, receiptTemplatePage, type ReceiptTemplateId } from '../lib/receipt-templates';

// The built-in's words, as Settings › Printing shows them.
const printerLabel = (profile: PrinterProfile) => profile.isBuiltIn ? 'Auto — Print dialog' : profile.name;

// v2's paid-screen Template and Printer selects, above the receipt; screen only, not printed.
export function ReceiptPickers({ templateId, onTemplateChange, printers, topInset = 0 }: {
  templateId: ReceiptTemplateId;
  onTemplateChange: (id: ReceiptTemplateId) => void;
  printers: PrinterProfile[];
  /** Space above the block when it leads the paid screen (no headline above it). */
  topInset?: number;
}) {
  const template = RECEIPT_TEMPLATES.find((t) => t.id === templateId) ?? RECEIPT_TEMPLATES[0]!;
  // Only the print dialog can print yet, so it is the one printer listed; it has nothing to change.
  const system = printers.filter((profile) => profile.connectionType === 'system');
  const printer = system[0];
  const row = (label: string, select: ReactNode) => <View className="flex-row items-center gap-4">
    <Text className="w-20 text-sm text-muted-foreground">{label}</Text>
    <View className="flex-1">{select}</View>
  </View>;
  return <View dataSet={{ print: 'hide' }} style={{ paddingTop: topInset + 16 }} className="w-full max-w-md self-center gap-2 px-4">
    {row('Template', <Select value={{ value: template.id, label: template.name }}
      onValueChange={(option) => { if (option) onTemplateChange(option.value as ReceiptTemplateId); }}>
      <SelectTrigger testID="receipt-template-select" accessibilityLabel="Template"><SelectValue placeholder="Template" /></SelectTrigger>
      <SelectContent>
        {RECEIPT_TEMPLATES.map((t) => <SelectItem key={t.id} testID={`receipt-template-option-${t.id}`} value={t.id} label={t.name}>
          <Text>{t.name}</Text>
        </SelectItem>)}
      </SelectContent>
    </Select>)}
    {printer ? row('Printer', <Select value={{ value: printer.id, label: printerLabel(printer) }}>
      <SelectTrigger testID="receipt-printer-select" accessibilityLabel="Printer"><SelectValue placeholder="Printer" /></SelectTrigger>
      <SelectContent>
        {system.map((p) => <SelectItem key={p.id} value={p.id} label={printerLabel(p)}><Text>{printerLabel(p)}</Text></SelectItem>)}
      </SelectContent>
    </Select>) : null}
  </View>;
}

type PrintStatus = 'idle' | 'printing' | 'failed';

// The sale as a thermal template prints it, in place of the Standard receipt: the same buildReceiptData call and config
// TallyUI's Receipt makes, rendered for the template's paper in a sandboxed frame (as Settings' preview does).
export function ThermalPaidReceipt({ paper, order, posOrder, store, cashier, registerId, footerSlot, newSale }: {
  paper: ReceiptPaper;
  order: SentOrder;
  posOrder?: PosOrder;
  store: { name: string; address?: string };
  cashier: string;
  registerId: string;
  footerSlot?: ReactNode;
  newSale: () => void;
}) {
  const [status, setStatus] = useState<PrintStatus>('idle');
  const receipt = buildReceiptData(order, {
    storeName: store.name, storeAddress: store.address, cashier, register: registerId,
  });
  const page = receiptTemplatePage(paper, posOrder
    ? { ...receipt, header: { ...receipt.header, orderNumber: orderReference(posOrder) } } : receipt);
  const print = () => {
    setStatus('printing');
    printSalePage(page).then(() => setStatus('idle'), () => setStatus('failed'));
  };
  return <View className="w-full max-w-md self-center gap-3 p-4">
    <View className="overflow-hidden rounded-md border border-border">
      <iframe srcDoc={page} sandbox="" title="Receipt" data-testid="receipt-thermal-frame"
        style={{ width: '100%', height: 520, border: 0, background: '#fff' }} />
    </View>
    {footerSlot ? <View className="items-center border-t border-dashed border-border pt-3">{footerSlot}</View> : null}
    <View dataSet={{ print: 'hide' }} className="gap-3">
      <View className="flex-row gap-4">
        <Button variant="outline" testID="receipt-thermal-print" disabled={status === 'printing'} onPress={print}>
          <Text>Print receipt</Text>
        </Button>
        <Button testID="receipt-thermal-new-sale" onPress={newSale}><Text>New sale</Text></Button>
      </View>
      {status === 'failed' ? <Text testID="receipt-thermal-print-status" className="text-sm text-destructive">Couldn't print. Try again.</Text> : null}
    </View>
  </View>;
}
