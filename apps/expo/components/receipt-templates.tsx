import { Fragment, useContext, useRef, useState } from 'react';
import { Platform, useWindowDimensions, View } from 'react-native';
import {
  Badge, Button, Dialog, DialogClose, DialogContent, DialogTitle, IconButton, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Text, XIcon,
} from '@tallyui/components';
import type { PrinterProfile } from '@tallyui/pos';
import { useOutboxOrders } from '../lib/outbox-context';
import { usePrinterProfiles } from '../lib/printers';
import { SettingsFlatContext, SettingsGroup, SettingsRow } from '../lib/settings-layout';
import { printReceiptPage, RECEIPT_TEMPLATES, receiptTemplatePage, sampleReceipt, useReceiptPrinter } from '../lib/receipt-templates';
import { defaultStorage, type Session } from '../lib/session';
import { loadCachedSettings } from '../lib/store-settings';
import { FittedReceiptFrame, printerLabel, receiptPrintersFor } from './receipt-pickers';

type Template = (typeof RECEIPT_TEMPLATES)[number];
type PrintStatus = 'idle' | 'printing' | 'sent' | 'failed';

// A phone stacks the actions under the template name, since TU SettingsRow keeps its action beside the label.
const PHONE_BREAKPOINT = 600;

function TemplatePrinterSelect({ session, template, printers }: { session: Session; template: Template; printers: PrinterProfile[] }) {
  const { printerId, save } = useReceiptPrinter(defaultStorage(), session.baseUrl, template.id);
  const listed = receiptPrintersFor(template.id, printers);
  const printer = listed.find((profile) => profile.id === printerId) ?? listed.find((profile) => profile.connectionType === 'system');
  if (!printer) return null;
  const testID = `settings-receipt-template-${template.id}-printer`;
  return <View className="w-56 max-w-full">
    <Select value={{ value: printer.id, label: printerLabel(printer) }} onValueChange={(option) => { if (option) save(option.value); }}>
      <SelectTrigger testID={testID} accessibilityLabel={`Printer for ${template.name}`}><SelectValue placeholder="Printer" /></SelectTrigger>
      <SelectContent>
        {listed.map((profile) => <SelectItem key={profile.id} testID={`${testID}-option-${profile.id}`} value={profile.id} label={printerLabel(profile)}>
          <Text>{printerLabel(profile)}</Text>
        </SelectItem>)}
      </SelectContent>
    </Select>
  </View>;
}

// v2's Settings › Printing "Receipt templates": each template, its format and the printer it goes to.
export function ReceiptTemplatesGroup({ session }: { session: Session }) {
  const printers = usePrinterProfiles(useOutboxOrders());
  const web = Platform.OS === 'web';
  const phone = useWindowDimensions().width < PHONE_BREAKPOINT;
  // A flat row's actions fill its value column, so the select can shrink; a boxed row's wrap at the select's width.
  const flat = useContext(SettingsFlatContext);
  const [preview, setPreview] = useState<{ template: Template; page: string } | null>(null);
  const [status, setStatus] = useState<PrintStatus>('idle');
  // Each opening is its own; a print still pending from an earlier opening never shows its outcome here.
  const opening = useRef(0);
  const open = (template: Template) => {
    if (!template.paper) return;
    const settings = loadCachedSettings(defaultStorage(), session.baseUrl);
    const store = settings
      ? { name: settings.storeName, address: settings.location.addressLine, currency: settings.currency }
      : { name: 'Your store', currency: 'USD' };
    opening.current += 1;
    setStatus('idle');
    setPreview({ template, page: receiptTemplatePage(template.paper, sampleReceipt(store)) });
  };
  const close = () => {
    opening.current += 1;
    setStatus('idle');
    setPreview(null);
  };
  const testPrint = (page: string) => {
    const mine = opening.current;
    setStatus('printing');
    printReceiptPage(page).then(
      () => { if (opening.current === mine) setStatus('sent'); },
      () => { if (opening.current === mine) setStatus('failed'); },
    );
  };
  return <SettingsGroup divider title="Receipt templates" testID="settings-receipt-templates"
    description="Choose which printer each template prints to.">
    {RECEIPT_TEMPLATES.map((template, index) => {
      const actions = <>
        <Badge variant="secondary" label={template.tag} />
        {web ? <TemplatePrinterSelect session={session} template={template} printers={printers} /> :
          <Text testID={`settings-receipt-template-${template.id}-printer`} className="text-right text-sm text-foreground">
            Not available on this device
          </Text>}
        {web && template.paper ? <Button variant="outline" size="sm" testID={`settings-receipt-template-${template.id}-preview`}
          accessibilityLabel={`Preview ${template.name}`} onPress={() => open(template)}>
          <Text>Preview</Text>
        </Button> : null}
      </>;
      return <Fragment key={template.id}>
        <SettingsRow label={template.name} testID={`settings-receipt-template-${template.id}`}
          divider={index > 0}
          action={phone ? undefined : <View className={`flex-row flex-wrap items-center gap-3 ${flat ? 'w-full' : 'max-w-56 justify-end'}`}>{actions}</View>} />
        {phone ? <View testID={`settings-receipt-template-${template.id}-actions`}
          className="flex-row flex-wrap items-center gap-3 px-4 pb-3">{actions}</View> : null}
      </Fragment>;
    })}
    <Dialog open={preview !== null} onOpenChange={(next) => { if (!next) close(); }}>
      {preview ? <DialogContent side="right" testID="receipt-template-preview" className="flex-col p-0">
        <View className="flex-row items-start justify-between gap-3 p-4">
          <View className="flex-1 gap-1">
            <DialogTitle className="text-lg font-semibold">{preview.template.name}</DialogTitle>
            <Text className="text-sm text-muted-foreground">Sample sale</Text>
          </View>
          <DialogClose asChild>
            <IconButton variant="ghost" size="sm" accessibilityLabel="Close panel"><XIcon size={16} /></IconButton>
          </DialogClose>
        </View>
        <View className="flex-1">
          {web ? <FittedReceiptFrame page={preview.page} title="Receipt preview" testID="receipt-template-preview-frame" /> : null}
        </View>
        <View className="gap-3 border-t border-border p-4">
          {status === 'sent' ? <Text testID="receipt-template-print-status" className="text-sm text-muted-foreground">Sent to Print dialog</Text>
            : status === 'failed' ? <Text testID="receipt-template-print-status" className="text-sm text-destructive">Couldn't print. Try again.</Text>
              : null}
          <View className="flex-row flex-wrap gap-2">
            <Button testID="receipt-template-test-print" disabled={status === 'printing'} onPress={() => testPrint(preview.page)}>
              <Text>Test print</Text>
            </Button>
            <Button variant="outline" testID="receipt-template-close" onPress={close}><Text>Close</Text></Button>
          </View>
        </View>
      </DialogContent> : null}
    </Dialog>
  </SettingsGroup>;
}
