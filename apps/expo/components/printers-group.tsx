import { Fragment, useRef, useState } from 'react';
import { Platform, ScrollView, View } from 'react-native';
import { Path } from 'react-native-svg';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  Badge, Button, createSvgIcon, Dialog, DialogContent, DialogTitle, PrinterForm, Text, type PrinterFormDraft,
} from '@tallyui/components';
import { SettingsGroup, SettingsRow } from '../lib/settings-layout';
import { PrintError, type PrinterProfile } from '@tallyui/pos';
import { useOutboxOrders } from '../lib/outbox-context';
import { deletePrinter, PRINTER_REFUSALS, printerProfilesOf, printerTestPage, printTestPage, savePrinter, usePrinterProfiles } from '../lib/printers';
import { defaultStorage, type Session } from '../lib/session';
import { loadCachedSettings } from '../lib/store-settings';
import { printTestReceipt } from '../lib/thermal-printing';

type PrintStatus = 'printing' | 'sent' | 'failed';

const PlusIcon = createSvgIcon('PlusIcon', () => <><Path d="M12 5l0 14" /><Path d="M5 12l14 0" /></>);
const VENDORS: Record<string, string> = { epson: 'Epson', star: 'Star', generic: 'Generic' };
const NETWORK_FAILED = "Couldn't print. Check the printer's address and that it is on.";

// A network printer's second line: vendor and address, then what it does beyond printing.
const networkLine = (profile: PrinterProfile) => [VENDORS[profile.vendor ?? 'generic'], profile.address,
  profile.autoOpenDrawer ? 'Opens cash drawer' : null, profile.isDefault ? 'Default' : null].filter(Boolean).join(' · ');

// v2's Settings › Printing "Printers": the print dialog built in, and on the web v2's "+ Add printer" for an Epson or
// Star network printer. Receipts still go through the print dialog; a network printer opens the cash drawer.
export function PrintersGroup({ session }: { session: Session }) {
  const web = Platform.OS === 'web';
  const orders = useOutboxOrders();
  const collection = orders ? printerProfilesOf(orders) : undefined;
  const profiles = usePrinterProfiles(orders);
  const [status, setStatus] = useState<Record<string, PrintStatus>>({});
  const pending = useRef(new Set<string>());
  const [editing, setEditing] = useState<{ printer?: PrinterProfile } | null>(null);
  const [formTest, setFormTest] = useState<{ status: PrintStatus; name: string; failure?: string } | null>(null);
  // Each opening of the form is its own; a test print from an earlier opening never shows its outcome here.
  const opening = useRef(0);
  const [deleting, setDeleting] = useState<PrinterProfile | null>(null);
  const store = () => {
    const settings = loadCachedSettings(defaultStorage(), session.baseUrl);
    return settings ? { name: settings.storeName, address: settings.location.addressLine, currency: settings.currency }
      : { name: 'Your store', currency: 'USD' };
  };
  const testPrint = (profile: PrinterProfile) => {
    if (pending.current.has(profile.id)) return;
    pending.current.add(profile.id);
    const settle = (next: PrintStatus) => {
      pending.current.delete(profile.id);
      setStatus((current) => ({ ...current, [profile.id]: next }));
    };
    setStatus((current) => ({ ...current, [profile.id]: 'printing' }));
    const printed = profile.connectionType === 'system'
      ? printTestPage(profile, printerTestPage({ printerName: profile.name, storeName: store().name }))
      : printTestReceipt(profile, store());
    printed.then(() => settle('sent'), () => settle('failed'));
  };
  const openForm = (printer?: PrinterProfile) => { opening.current += 1; setFormTest(null); setEditing({ printer }); };
  const closeForm = () => { opening.current += 1; setFormTest(null); setEditing(null); };
  const save = async (draft: PrinterFormDraft) => {
    if (!collection) return 'The printer was not saved. Try again.';
    const refused = await savePrinter(collection, draft, editing?.printer?.id);
    if (refused === null) closeForm();
    return refused;
  };
  const formTestPrint = (draft: PrinterFormDraft) => {
    const mine = opening.current;
    setFormTest({ status: 'printing', name: draft.name });
    const settle = (next: PrintStatus, failure?: string) => { if (opening.current === mine) setFormTest({ status: next, name: draft.name, failure }); };
    const failure = (error: unknown) => !(error instanceof PrintError && error.code === 'unsupported') ? NETWORK_FAILED
      : draft.connectionType === 'system' ? PRINTER_REFUSALS.system : PRINTER_REFUSALS.vendor;
    printTestReceipt({ ...draft, id: 'draft' }, store()).then(() => settle('sent'), (error: unknown) => settle('failed', failure(error)));
  };
  const remove = (profile: PrinterProfile) => {
    setDeleting(null);
    if (collection) deletePrinter(collection, profile.id).catch((error: unknown) => console.warn('Could not delete the printer:', error));
  };
  const networkRows = profiles.filter((profile) => !profile.isBuiltIn && profile.connectionType === 'network');
  return <SettingsGroup divider title="Printers" testID="settings-printers" description="Devices receipts can be sent to.">
    {profiles.map((profile, index) => {
      const id = `settings-printer-${profile.id}`;
      const network = web && !profile.isBuiltIn && profile.connectionType === 'network';
      const printable = web && (profile.connectionType === 'system' || network);
      return <Fragment key={profile.id}>
        <SettingsRow label={profile.name} testID={id} divider={index > 0}
          description={!profile.isBuiltIn && profile.connectionType === 'network' ? networkLine(profile) : undefined} action={
          <View className="flex-row flex-wrap items-center justify-end gap-3">
            {profile.isBuiltIn ? <Badge variant="secondary" label="Built-in" /> : null}
            {printable ? <Button variant="outline" size="sm" testID={`${id}-test-print`} accessibilityLabel={`Test print ${profile.name}`}
              disabled={status[profile.id] === 'printing'} onPress={() => testPrint(profile)}>
              <Text>Test print</Text>
            </Button> : <Text testID={`${id}-status`} className="text-right text-sm text-muted-foreground">Not available on this device</Text>}
            {network ? <>
              <Button variant="outline" size="sm" testID={`${id}-edit`} accessibilityLabel={`Edit ${profile.name}`} onPress={() => openForm(profile)}>
                <Text>Edit</Text>
              </Button>
              <Button variant="outline" size="sm" testID={`${id}-delete`} accessibilityLabel={`Delete ${profile.name}`} onPress={() => setDeleting(profile)}>
                <Text>Delete</Text>
              </Button>
            </> : null}
          </View>
        } />
        {status[profile.id] === 'sent' ? <View className="px-4 pb-4">
          <Text testID={`${id}-print-status`} className="text-sm text-muted-foreground">{`Sent to ${profile.name}`}</Text>
        </View> : status[profile.id] === 'failed' ? <View className="px-4 pb-4">
          <Text testID={`${id}-print-status`} className="text-sm text-destructive">
            {profile.connectionType === 'system' ? "Couldn't print. Try again." : NETWORK_FAILED}
          </Text>
        </View> : null}
      </Fragment>;
    })}
    {networkRows.length > 0 ? <Text testID="settings-printers-note" className="px-4 pb-2 text-sm text-muted-foreground">
      Receipts still print through the print dialog. Network printers open the cash drawer.
    </Text> : null}
    {web && collection ? <View className="flex-row px-4 py-3">
      <Button testID="settings-add-printer" accessibilityLabel="Add printer" onPress={() => openForm()}>
        <View className="text-primary-foreground"><PlusIcon size={16} /></View>
        <Text>Add printer</Text>
      </Button>
    </View> : null}
    {editing ? <Dialog open onOpenChange={(next) => { if (!next) closeForm(); }}>
      <DialogContent testID="printer-dialog" className="max-h-[90%] gap-4">
        <DialogTitle>{editing.printer ? 'Edit printer' : 'Add printer'}</DialogTitle>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerClassName="gap-3">
          <PrinterForm printer={editing.printer} onSave={save} onCancel={closeForm} onTest={formTestPrint} />
          {formTest && formTest.status !== 'printing' ? <Text testID="printer-form-test-status"
            className={formTest.status === 'sent' ? 'text-sm text-muted-foreground' : 'text-sm text-destructive'}>
            {formTest.status === 'sent' ? `Sent to ${formTest.name}` : formTest.failure}
          </Text> : null}
        </ScrollView>
      </DialogContent>
    </Dialog> : null}
    {deleting ? <AlertDialog open onOpenChange={(next) => { if (!next) setDeleting(null); }}>
      <AlertDialogContent testID="printer-delete-dialog">
        <AlertDialogHeader><AlertDialogTitle>{`Delete ${deleting.name}?`}</AlertDialogTitle></AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel asChild onPress={() => setDeleting(null)}>
            <Button variant="outline" testID="printer-delete-cancel"><Text>Cancel</Text></Button>
          </AlertDialogCancel>
          <AlertDialogAction asChild onPress={() => remove(deleting)}>
            <Button variant="destructive" testID="printer-delete-confirm"><Text>Delete</Text></Button>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog> : null}
  </SettingsGroup>;
}
