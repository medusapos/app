import { Fragment, useRef, useState } from 'react';
import { Platform, View } from 'react-native';
import { Badge, Button, Text } from '@tallyui/components';
import { SettingsGroup, SettingsRow } from '../lib/settings-layout';
import type { PrinterProfile } from '@tallyui/pos';
import { useOutboxOrders } from '../lib/outbox-context';
import { printerTestPage, printTestPage, usePrinterProfiles } from '../lib/printers';
import { defaultStorage, type Session } from '../lib/session';
import { loadCachedSettings } from '../lib/store-settings';

type PrintStatus = 'printing' | 'sent' | 'failed';

// v2's Settings › Printing "Printers": the printers this till can send receipts to. A browser till has one, the
// print dialog; adding a network printer waits on a TallyUI transport.
export function PrintersGroup({ session }: { session: Session }) {
  const web = Platform.OS === 'web';
  const profiles = usePrinterProfiles(useOutboxOrders());
  const [status, setStatus] = useState<Record<string, PrintStatus>>({});
  const pending = useRef(new Set<string>());
  const testPrint = (profile: PrinterProfile) => {
    if (pending.current.has(profile.id)) return;
    pending.current.add(profile.id);
    const settle = (next: PrintStatus) => {
      pending.current.delete(profile.id);
      setStatus((current) => ({ ...current, [profile.id]: next }));
    };
    setStatus((current) => ({ ...current, [profile.id]: 'printing' }));
    const storeName = loadCachedSettings(defaultStorage(), session.baseUrl)?.storeName ?? 'Your store';
    printTestPage(profile, printerTestPage({ printerName: profile.name, storeName })).then(() => settle('sent'), () => settle('failed'));
  };
  return <SettingsGroup title="Printers" testID="settings-printers" description="Devices receipts can be sent to.">
    {profiles.map((profile, index) => {
      const id = `settings-printer-${profile.id}`;
      const printable = web && profile.connectionType === 'system';
      return <Fragment key={profile.id}>
        <SettingsRow label={profile.name} testID={id} divider={index > 0} action={
          <View className="flex-row flex-wrap items-center justify-end gap-3">
            {profile.isBuiltIn ? <Badge variant="secondary" label="Built-in" /> : null}
            {printable ? <Button variant="outline" size="sm" testID={`${id}-test-print`} accessibilityLabel={`Test print ${profile.name}`}
              disabled={status[profile.id] === 'printing'} onPress={() => testPrint(profile)}>
              <Text>Test print</Text>
            </Button> : <Text testID={`${id}-status`} className="text-right text-sm text-muted-foreground">Not available on this device</Text>}
          </View>
        } />
        {status[profile.id] === 'sent' ? <View className="px-4 pb-4">
          <Text testID={`${id}-print-status`} className="text-sm text-muted-foreground">Sent to Print dialog</Text>
        </View> : status[profile.id] === 'failed' ? <View className="px-4 pb-4">
          <Text testID={`${id}-print-status`} className="text-sm text-destructive">Couldn't print. Try again.</Text>
        </View> : null}
      </Fragment>;
    })}
  </SettingsGroup>;
}
