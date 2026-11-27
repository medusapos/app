import type { ReactNode } from 'react';
import { View } from 'react-native';
import { orderReference, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Text } from '@tallyui/components';
import { buildReceiptData, networkSinkFor, type PosOrder, type PrinterProfile, type ReceiptData, type ReceiptPaper, type SentOrder } from '@tallyui/pos';
import { RECEIPT_TEMPLATES, receiptTemplatePage, type ReceiptTemplateId } from '../lib/receipt-templates';

// The built-in's words, as Settings › Printing shows them.
const printerLabel = (profile: PrinterProfile) => profile.isBuiltIn ? 'Auto — Print dialog' : profile.name;

// v2's paid-screen Template and Printer selects, above the receipt; screen only, not printed.
export function ReceiptPickers({ templateId, onTemplateChange, printers, printerId, onPrinterChange, topInset = 0 }: {
  templateId: ReceiptTemplateId;
  onTemplateChange: (id: ReceiptTemplateId) => void;
  printers: PrinterProfile[];
  printerId?: string;
  onPrinterChange?: (printerId: string) => void;
  /** Space above the block when it leads the paid screen (no headline above it). */
  topInset?: number;
}) {
  const template = RECEIPT_TEMPLATES.find((t) => t.id === templateId) ?? RECEIPT_TEMPLATES[0]!;
  const listed = receiptPrintersFor(templateId, printers);
  const printer = listed.find((profile) => profile.id === printerId) ?? listed[0];
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
    {printer ? row('Printer', <Select value={{ value: printer.id, label: printerLabel(printer) }} onValueChange={(option) => { if (option) onPrinterChange?.(option.value); }}>
      <SelectTrigger testID="receipt-printer-select" accessibilityLabel="Printer"><SelectValue placeholder="Printer" /></SelectTrigger>
      <SelectContent>
        {listed.map((p) => <SelectItem key={p.id} testID={`receipt-printer-option-${p.id}`} value={p.id} label={printerLabel(p)}><Text>{printerLabel(p)}</Text></SelectItem>)}
      </SelectContent>
    </Select>) : null}
  </View>;
}

export function receiptPrintersFor(templateId: ReceiptTemplateId, printers: PrinterProfile[]): PrinterProfile[] {
  const system = printers.filter((profile) => profile.connectionType === 'system');
  return RECEIPT_TEMPLATES.find((template) => template.id === templateId)?.paper
    ? system.concat(printers.filter((profile) => profile.connectionType === 'network' && networkSinkFor(profile) !== null)) : system;
}

// The sale as a thermal template prints it, in place of the Standard receipt: the same buildReceiptData call and config
// TallyUI's Receipt makes, rendered for the template's paper.
export function paidReceiptData({ order, posOrder, store, cashier, registerId }: {
  order: SentOrder;
  posOrder?: PosOrder;
  store: { name: string; address?: string };
  cashier: string;
  registerId: string;
}): ReceiptData {
  const receipt = buildReceiptData(order, {
    storeName: store.name, storeAddress: store.address, cashier, register: registerId,
  });
  return posOrder ? { ...receipt, header: { ...receipt.header, orderNumber: orderReference(posOrder) } } : receipt;
}

export function thermalPaidPage({ paper, ...args }: { paper: ReceiptPaper } & Parameters<typeof paidReceiptData>[0]): string {
  return receiptTemplatePage(paper, paidReceiptData(args));
}

// The thermal page in a sandboxed frame (as Settings' preview does); the paid footer prints it.
export function ThermalPaidReceipt({ page }: { page: string }) {
  return <View className="w-full max-w-md self-center p-4">
    <View className="overflow-hidden rounded-md border border-border">
      <iframe srcDoc={page} sandbox="" title="Receipt" data-testid="receipt-thermal-frame"
        style={{ width: '100%', height: 520, border: 0, background: '#fff' }} />
    </View>
  </View>;
}
