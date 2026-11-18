import { useRef, useState } from 'react';
import { Platform, View } from 'react-native';
import {
  Badge, Button, Dialog, DialogClose, DialogContent, DialogTitle, IconButton, SettingsGroup, SettingsRow, Text, XIcon,
} from '@tallyui/components';
import { printReceiptPage, RECEIPT_TEMPLATES, receiptTemplatePage, sampleReceipt } from '../lib/receipt-templates';
import { defaultStorage, type Session } from '../lib/session';
import { loadCachedSettings } from '../lib/store-settings';

type Template = (typeof RECEIPT_TEMPLATES)[number];
type PrintStatus = 'idle' | 'printing' | 'sent' | 'failed';

// v2's Settings › Printing "Receipt templates": each template, its format and the printer it goes to. A browser till
// has one printer, the print dialog; a native till has none yet.
export function ReceiptTemplatesGroup({ session }: { session: Session }) {
  const web = Platform.OS === 'web';
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
  return <SettingsGroup title="Receipt templates" testID="settings-receipt-templates"
    description="Choose which printer each template prints to. Sales print the Standard Receipt.">
    {RECEIPT_TEMPLATES.map((template, index) => <SettingsRow key={template.id} label={template.name}
      testID={`settings-receipt-template-${template.id}`} className={index > 0 ? 'border-t border-border' : undefined} action={
        <View className="flex-row flex-wrap items-center justify-end gap-3">
          <Badge variant="secondary" label={template.tag} />
          <Text testID={`settings-receipt-template-${template.id}-printer`} className="text-right text-sm text-foreground">
            {web ? 'Auto — Print dialog' : 'Not available on this device'}
          </Text>
          {web && template.paper ? <Button variant="outline" size="sm" testID={`settings-receipt-template-${template.id}-preview`}
            accessibilityLabel={`Preview ${template.name}`} onPress={() => open(template)}>
            <Text>Preview</Text>
          </Button> : null}
        </View>
      } />)}
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
          {web ? <iframe srcDoc={preview.page} sandbox="" title="Receipt preview" data-testid="receipt-template-preview-frame"
            style={{ flex: 1, width: '100%', height: '100%', border: 0, background: '#fff' }} /> : null}
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
