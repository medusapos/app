import { useState, type ReactNode } from 'react';
import { View } from 'react-native';
import { orderReference, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Text } from '@tallyui/components';
import { buildReceiptData, networkSinkFor, type PosOrder, type PrinterProfile, type ReceiptData, type ReceiptPaper, type SentOrder } from '@tallyui/pos';
import { RECEIPT_TEMPLATES, receiptTemplatePage, type ReceiptTemplateId } from '../lib/receipt-templates';
import { BUILT_IN_PRINTER } from '../lib/printers';

// The built-in's words, as Settings › Printing shows them.
export const printerLabel = (profile: PrinterProfile) => profile.isBuiltIn ? 'Auto — Print dialog' : profile.name;

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
  if (!system.length) system.push(BUILT_IN_PRINTER);
  return RECEIPT_TEMPLATES.find((template) => template.id === templateId)?.paper
    ? system.concat(printers.filter((profile) => profile.connectionType === 'network' && networkSinkFor(profile) !== null)) : system;
}

export function chosenNetworkPrinter(templateId: ReceiptTemplateId, printers: PrinterProfile[], printerId: string): PrinterProfile | undefined {
  return receiptPrintersFor(templateId, printers).find((p) => p.id === printerId && p.connectionType === 'network');
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

// The frame's width: the page's own, plus the scrollbar only while the frame, at the height that width gives it,
// still scrolls (a classic scrollbar, #667); in between, just wide (so tall) enough that the frame no longer scrolls.
// Chromium sizes the frame's viewport in whole pixels, so the frame must be at least ceil(height) tall once fitted;
// the extra pixel keeps it there through floating-point error in the box's height over the scale (#677).
export function fittedFrameWidth({ right, bar, height }: { right: number; bar: number; height: number },
  box: { width: number; height: number }) {
  if (!box.height) return right + bar;
  return Math.min(right + bar, Math.max(right, Math.ceil(box.width * (Math.ceil(height) + 1) / box.height)));
}

// The thermal page in a sandboxed frame, filling the box its parent gives it; the paid footer and Settings' preview show it.
// The page is a fixed-width column (48ch at 80mm, ~400px), wider than a phone's frame: the frame takes the page's own
// width and is scaled down to the box, never up, its layout height grown by 1/scale so the drawn height fills the box.
// allow-same-origin (never allow-scripts, so nothing runs in the frame) lets onLoad measure the loaded page's right edge,
// its height and its scrollbar (0 when it does not scroll, or the scrollbar overlays); srcDoc stays the printed page untouched.
export function FittedReceiptFrame({ page, title, testID }: { page: string; title: string; testID: string }) {
  const [measured, setMeasured] = useState({ right: 0, bar: 0, height: 0 });
  const [box, setBox] = useState({ width: 0, height: 0 });
  const natural = fittedFrameWidth(measured, box);
  const scale = natural && box.width ? Math.min(1, box.width / natural) : 1;
  const measure = (frame: HTMLIFrameElement) => {
    const doc = frame.contentDocument;
    if (!doc?.body || !frame.contentWindow) return;
    const edge = Math.max(0, ...Array.from(doc.body.children, (el) => el.getBoundingClientRect().right));
    setMeasured({ right: Math.ceil(edge), bar: frame.contentWindow.innerWidth - doc.documentElement.clientWidth,
      height: doc.documentElement.getBoundingClientRect().height });
  };
  // The scaled frame's taller layout box is clipped, not grown into.
  return <View className="flex-1 overflow-hidden"
    onLayout={(event) => setBox({ width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height })}>
    <iframe srcDoc={page} sandbox="allow-same-origin" title={title} data-testid={testID}
      onLoad={(event) => measure(event.currentTarget)}
      style={{ width: scale < 1 ? natural : '100%', height: box.height ? box.height / scale : '100%', flexShrink: 0, border: 0,
        background: '#fff', transform: scale < 1 ? `scale(${scale})` : undefined, transformOrigin: '0 0' }} />
  </View>;
}

// The paid footer's thermal receipt: the fitted frame in a bordered box.
export function ThermalPaidReceipt({ page }: { page: string }) {
  return <View className="w-full max-w-md self-center p-4">
    {/* 520 visible + the 1px borders. */}
    <View className="overflow-hidden rounded-md border border-border" style={{ height: 522 }}>
      <FittedReceiptFrame page={page} title="Receipt" testID="receipt-thermal-frame" />
    </View>
  </View>;
}
